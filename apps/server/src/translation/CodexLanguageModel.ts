import * as AiError from "effect/ai/AiError";
import * as LanguageModel from "effect/ai/LanguageModel";
import type * as Response from "effect/ai/Response";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { userStateFolder } from "../state/userFolders.ts";
import { ChildEnvironment } from "./ChildEnvironment.ts";
import { findProgram, isNodeScript } from "./findProgram.ts";
import { agentPrompt, noStreaming, textMessages, withoutFence } from "./prompt.ts";

export interface ConfigOptions {
  /** How hard Codex reasons, one of the model's levels. Codex's own default when unset. */
  readonly effort?: string;
}

/** Settings for the requests inside it; set them with `withConfigOverride`. */
const Config = Context.Reference<ConfigOptions>(
  "@rpgtl/server/translation/CodexLanguageModel/Config",
  { defaultValue: () => ({}) },
);

/** How the installed `codex` CLI starts, found on `PATH`; tests replace it. */
export const CodexCommand = Context.Reference<{
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}>("@rpgtl/server/translation/CodexLanguageModel/CodexCommand", {
  defaultValue: () => ({ command: "codex", args: [] }),
});

export class CodexMissingError extends Schema.TaggedError<CodexMissingError>()(
  "CodexMissingError",
  {},
) {
  override get message() {
    return "The Codex CLI isn't installed. Install it from https://developers.openai.com/codex/cli.";
  }
}

/**
 * Turns Codex into a plain chat: its own system prompt, skills list, AGENTS.md files, user config,
 * subagents and sandbox notes are left out. Codex still lists a few tools the model catalog sets
 * (a JavaScript runner, apply_patch, a clock), which the read-only sandbox keeps harmless.
 */
const plainChatSettings = [
  ...[
    'forced_login_method="chatgpt"',
    'approval_policy="never"',
    'web_search="disabled"',
    "project_doc_max_bytes=0",
    "skills.include_instructions=false",
    "agents.enabled=false",
    "tools.experimental_request_user_input.enabled=false",
    "include_environment_context=false",
    "include_permissions_instructions=false",
    "include_apps_instructions=false",
    "include_collaboration_mode_instructions=false",
  ].flatMap((setting) => ["--config", setting]),
  ...[
    "multi_agent_v2",
    "sleep_tool",
    "shell_tool",
    "unified_exec",
    "view_image",
    "image_generation",
    "goals",
    "apply_patch_freeform",
    "current_time_reminder",
    "plugins",
    "apps",
    "memories",
  ].flatMap((feature) => ["--disable", feature]),
];

const execFlags = [
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--skip-git-repo-check",
  "--sandbox",
  "read-only",
];

/** The events of `codex exec --json` that RPGTL reads; Codex sends others. */
const CodexEvent = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("item.completed"),
      item: Schema.Struct({ type: Schema.Literal("agent_message"), text: Schema.String }),
    }),
    Schema.Struct({
      type: Schema.Literal("turn.completed"),
      usage: Schema.Struct({
        input_tokens: Schema.Finite,
        output_tokens: Schema.Finite,
        reasoning_output_tokens: Schema.Finite,
      }),
    }),
    Schema.Struct({
      type: Schema.Literal("turn.failed"),
      error: Schema.Struct({ message: Schema.String }),
    }),
    Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
  ]),
);
type CodexEvent = typeof CodexEvent.Type;
type Usage = Extract<CodexEvent, { type: "turn.completed" }>["usage"];

const failure = (reason: AiError.AiErrorReason) =>
  AiError.make({ module: "CodexLanguageModel", method: "generateText", reason });

const cliFailed = (cause: unknown) =>
  Effect.logWarning("The Codex CLI couldn't be run.", cause).pipe(
    Effect.andThen(
      failure(new AiError.InternalProviderError({ description: "The Codex CLI couldn't be run." })),
    ),
  );

/** A failed turn, whose reason is the usage limit when Codex says so. */
const turnFailed = (said: string) =>
  Effect.logWarning("Codex answered with an error.", said).pipe(
    Effect.andThen(
      failure(
        /usage limit/i.test(said)
          ? new AiError.QuotaExhaustedError({})
          : new AiError.UnknownError({ description: "Codex answered with an error." }),
      ),
    ),
  );

/**
 * The installed `codex` CLI on RPGTL's own Codex home (RPGTL's user state folder, `codex/`), started
 * there. Without an API key in its environment, only the ChatGPT login pays.
 */
export const codexCli = Effect.gen(function* () {
  const path = yield* Path.Path;
  const codexCommand = yield* CodexCommand;
  const program = yield* findProgram(codexCommand.command);
  if (Option.isNone(program)) return yield* new CodexMissingError();
  const environment = yield* ChildEnvironment;
  const home = path.join(yield* userStateFolder, "codex");
  const env = {
    ...Object.fromEntries(
      Object.entries(environment).filter(([name]) => !/^(?:CODEX|OPENAI)_/.test(name)),
    ),
    CODEX_HOME: home,
  };
  // npm's Codex on Windows is a Node script; RPGTL's own Node runs it.
  const [command, ...start] = isNodeScript(program.value)
    ? [process.execPath, program.value]
    : [program.value];
  return {
    home,
    command: (args: ReadonlyArray<string>, options: ChildProcess.CommandOptions) =>
      ChildProcess.make(command, [...start, ...codexCommand.args, ...args], {
        ...options,
        cwd: home,
        env,
      }),
  };
});

/**
 * Codex through `codex exec`, with a home of its own (RPGTL's user state folder, `codex/`) and its
 * ChatGPT login, so a ChatGPT plan pays for it. Codex always reads `AGENTS.md` and skills from its
 * home, and two homes sharing one `auth.json` could each refresh its token and log the other out.
 * Building it fails without a ChatGPT login, since `codex exec` would retry for ten seconds first.
 */
const make = Effect.fn("CodexLanguageModel.make")(function* (options: { readonly model: string }) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cli = yield* codexCli.pipe(
    Effect.catchTags({
      CodexMissingError: (error) =>
        AiError.make({
          module: "CodexLanguageModel",
          method: "make",
          reason: new AiError.InternalProviderError({ description: error.message }),
        }),
    }),
  );
  const codex = (args: ReadonlyArray<string>, stdin: string) =>
    cli.command(args, {
      stdin: Stream.make(new TextEncoder().encode(stdin)),
      forceKillAfter: Duration.seconds(5),
    });

  yield* fs.makeDirectory(cli.home, { recursive: true });
  if ((yield* spawner.exitCode(codex(["login", "status"], ""))) !== 0)
    return yield* AiError.make({
      module: "CodexLanguageModel",
      method: "make",
      reason: new AiError.AuthenticationError({
        kind: "MissingKey",
        description:
          "Codex is not logged in. Log in once with rpgtl codex login, or pnpm run codex login in a checkout.",
      }),
    });

  // LanguageModel already gives each request a span.
  const generateText = Effect.fnUntraced(function* (provider: LanguageModel.ProviderOptions) {
    const { effort } = yield* Config;
    const { system, prompt } = agentPrompt(
      yield* textMessages("CodexLanguageModel", provider.prompt),
    );
    const handle = yield* spawner
      .spawn(
        codex(
          [
            "exec",
            "--json",
            ...execFlags,
            ...plainChatSettings,
            "--model",
            options.model,
            ...(effort ? ["--config", `model_reasoning_effort="${effort}"`] : []),
            "--config",
            `instructions=${JSON.stringify(system)}`,
            "-",
          ],
          prompt,
        ),
      )
      .pipe(Effect.catchTags({ PlatformError: cliFailed }));
    const [read, stderr] = yield* Effect.all(
      [
        handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.filterMap(Schema.decodeUnknownResult(CodexEvent)),
          Stream.runFold(
            // "error" events also report retries that may still succeed; only a finished turn
            // counts.
            (): { content?: string; usage?: Usage; lastError?: string } => ({}),
            (state, event) =>
              event.type === "item.completed"
                ? { ...state, content: event.item.text }
                : event.type === "turn.completed"
                  ? { ...state, usage: event.usage }
                  : {
                      ...state,
                      lastError: event.type === "error" ? event.message : event.error.message,
                    },
          ),
        ),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.catchTags({ PlatformError: cliFailed }));
    const exitCode = yield* handle.exitCode.pipe(Effect.catchTags({ PlatformError: cliFailed }));
    const { content, usage, lastError } = read;
    if (exitCode !== 0) {
      if (lastError !== undefined) return yield* turnFailed(lastError);
      yield* Effect.logWarning(`Codex exited with code ${exitCode}.`, stderr.trim());
      return yield* failure(
        new AiError.InternalProviderError({ description: `Codex exited with code ${exitCode}.` }),
      );
    }
    if (!usage || content === undefined)
      return yield* lastError === undefined
        ? failure(new AiError.InvalidOutputError({ description: "Codex gave no answer." }))
        : turnFailed(lastError);
    return [
      { type: "text", text: withoutFence(content) },
      {
        type: "finish",
        reason: "stop",
        usage: {
          inputTokens: { uncached: undefined, total: usage.input_tokens },
          outputTokens: {
            total: usage.output_tokens,
            text: usage.output_tokens - usage.reasoning_output_tokens,
            reasoning: usage.reasoning_output_tokens,
          },
        },
      },
    ] satisfies Array<Response.PartEncoded>;
  }, Effect.scoped);

  return yield* LanguageModel.make({ generateText, streamText: noStreaming("CodexLanguageModel") });
});

export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(LanguageModel.LanguageModel, make(options));

/** Runs `self` with these settings over the current ones, such as a request's over its run's. */
export const withConfigOverride =
  (overrides: ConfigOptions) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.updateService(self, Config, (current) => ({ ...current, ...overrides }));
