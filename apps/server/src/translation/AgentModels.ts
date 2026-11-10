import { type ModelInfo, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentModel } from "@rpgtl/contracts";
import type * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type ClaudeMissingError, claudeCli } from "./ClaudeLanguageModel.ts";
import { type CodexMissingError, codexCli } from "./CodexLanguageModel.ts";

/** The CLI is there, but didn't list its models. */
export class AgentModelsError extends Schema.TaggedError<AgentModelsError>()("AgentModelsError", {
  translator: Schema.Literals(["claude", "codex"]),
  problem: Schema.Literals(["loggedOut", "failed"]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message() {
    return this.problem === "loggedOut"
      ? "Codex is not logged in. Log in once with rpgtl codex login, or pnpm run codex login in a checkout."
      : `${this.translator === "claude" ? "Claude Code" : "Codex"} didn't list its models.`;
  }
}

/** The SDK's model list for the `claude` CLI at `program`; tests replace it. */
export const ClaudeModelList = Context.Reference<
  (options: {
    readonly program: string;
    readonly env: Record<string, string>;
    readonly cwd: string;
  }) => Effect.Effect<ReadonlyArray<ModelInfo>, AgentModelsError>
>("@rpgtl/server/translation/AgentModels/ClaudeModelList", {
  defaultValue: () => (options) =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        query({
          // A prompt that never comes keeps the CLI waiting, so it sends no request.
          prompt: Stream.toAsyncIterable(Stream.never),
          options: {
            pathToClaudeCodeExecutable: options.program,
            env: options.env,
            cwd: options.cwd,
            settingSources: [],
          },
        }),
      ),
      (session) =>
        Effect.tryPromise({
          try: () => session.supportedModels(),
          catch: (cause) =>
            new AgentModelsError({ translator: "claude", problem: "failed", cause }),
        }),
      (session) => Effect.sync(() => session.close()),
    ),
});

/**
 * A model's family and version from its id, as "Opus 5.5" from `claude-opus-5-5`. The list's own
 * names don't say this: `displayName` is the family alone, and only some plans start the
 * description with the version.
 */
const claudeModelName = (id: string) => {
  const parts = id
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .split("-");
  const words = parts.filter((part) => !/^\d+$/.test(part));
  if (words.length === 0) return id;
  const family = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  const version = parts.filter((part) => /^\d+$/.test(part)).join(".");
  return version === "" ? family : `${family} ${version}`;
};

const claudeModels = (list: ReadonlyArray<ModelInfo>): ReadonlyArray<AgentModel> => {
  const defaultId = list.find((info) => info.value === "default")?.resolvedModel;
  const models = new Map<string, AgentModel>();
  for (const info of list) {
    const id = info.resolvedModel ?? info.value;
    if (info.value === "default" || models.has(id)) continue;
    models.set(id, {
      id,
      name: claudeModelName(id),
      efforts: info.supportedEffortLevels ?? [],
      isDefault: id === defaultId,
    });
  }
  return [...models.values()];
};

const CodexModelList = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Literal(2),
    result: Schema.Struct({
      data: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          displayName: Schema.String,
          hidden: Schema.Boolean,
          isDefault: Schema.Boolean,
          defaultReasoningEffort: Schema.String,
          supportedReasoningEfforts: Schema.Array(
            Schema.Struct({ reasoningEffort: Schema.String }),
          ),
        }),
      ),
    }),
  }),
);

const codexRequests = [
  { id: 1, method: "initialize", params: { clientInfo: { name: "rpgtl", version: "0" } } },
  { method: "initialized" },
  { id: 2, method: "model/list", params: {} },
]
  .map((message) => `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  .join("");

/** The models the Claude and Codex CLIs offer their logins now, which depends on the plan. */
export class AgentModels extends Context.Service<
  AgentModels,
  {
    readonly claude: Effect.Effect<
      ReadonlyArray<AgentModel>,
      ClaudeMissingError | AgentModelsError | PlatformError.PlatformError | Config.ConfigError
    >;
    readonly codex: Effect.Effect<
      ReadonlyArray<AgentModel>,
      CodexMissingError | AgentModelsError | PlatformError.PlatformError | Config.ConfigError
    >;
  }
>()("@rpgtl/server/translation/AgentModels") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();

  const claude = Effect.gen(function* () {
    const cli = yield* claudeCli;
    const list = yield* ClaudeModelList;
    const models = yield* list(cli).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(30),
        orElse: () =>
          Effect.fail(new AgentModelsError({ translator: "claude", problem: "failed" })),
      }),
    );
    return claudeModels(models);
  }).pipe(Effect.provideContext(context), Effect.withSpan("AgentModels.claude"));

  const codex = Effect.gen(function* () {
    const cli = yield* codexCli;
    yield* fs.makeDirectory(cli.home, { recursive: true });
    if ((yield* spawner.exitCode(cli.command(["login", "status"], {}))) !== 0)
      return yield* new AgentModelsError({ translator: "codex", problem: "loggedOut" });
    // The app server answers over stdin and stdout, and ends when stdin closes.
    const handle = yield* spawner.spawn(
      cli.command(["app-server"], {
        stdin: Stream.concat(Stream.make(new TextEncoder().encode(codexRequests)), Stream.never),
        forceKillAfter: Duration.seconds(5),
      }),
    );
    const answer = yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filterMap(Schema.decodeUnknownResult(CodexModelList)),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: Duration.seconds(30),
        orElse: () => Effect.succeedNone,
      }),
    );
    if (Option.isNone(answer))
      return yield* new AgentModelsError({ translator: "codex", problem: "failed" });
    return answer.value.result.data
      .filter((model) => !model.hidden)
      .map((model): AgentModel => ({
        id: model.id,
        name: model.displayName,
        efforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
        defaultEffort: model.defaultReasoningEffort,
        isDefault: model.isDefault,
      }));
  }).pipe(Effect.scoped, Effect.provideContext(context), Effect.withSpan("AgentModels.codex"));

  return AgentModels.of({ claude, codex });
});

export const layer = Layer.effect(AgentModels, make);
