import { type EffortLevel, query, type Options } from "@anthropic-ai/claude-agent-sdk";
import * as AiError from "effect/ai/AiError";
import * as LanguageModel from "effect/ai/LanguageModel";
import type * as Response from "effect/ai/Response";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { userStateFolder } from "../state/userFolders.ts";
import { ChildEnvironment } from "./ChildEnvironment.ts";
import { findProgram } from "./findProgram.ts";
import { agentPrompt, noStreaming, textMessages, withoutFence } from "./prompt.ts";

declare module "effect/ai/Response" {
  export interface FinishPartMetadata {
    /** What the request would cost at API prices; a subscription counts it against its limits. */
    readonly claude?: { readonly costUsd: number } | null;
  }
}

export interface ConfigOptions {
  /**
   * How hard Claude thinks, one of the model's levels; the CLI's default when unset or a level it
   * doesn't know. Claude always decides itself whether to think: Opus can't turn thinking off, and
   * Sonnet thinks anyway.
   */
  readonly effort?: string;
  /**
   * The CLI writes the whole prompt to the cache at 1.25 times the input price, and a later request
   * reads back only the part it starts with, at 0.1 times. Turn it off where requests share little
   * more than the system prompt and never repeat, such as dialogue batches. On unless set.
   */
  readonly cache?: boolean;
}

const effortLevels: ReadonlyArray<string> = ["low", "medium", "high", "xhigh", "max"];
const isEffortLevel = (effort: string): effort is EffortLevel => effortLevels.includes(effort);

/** Settings for the requests inside it; set them with `withConfigOverride`. */
const Config = Context.Reference<ConfigOptions>(
  "@rpgtl/server/translation/ClaudeLanguageModel/Config",
  { defaultValue: () => ({}) },
);

/** The installed `claude` CLI, found on `PATH`; tests replace it. */
export const ClaudeProgram = Context.Reference<string>(
  "@rpgtl/server/translation/ClaudeLanguageModel/ClaudeProgram",
  { defaultValue: () => "claude" },
);

/** The Agent SDK's `query`, which tests replace; its messages are decoded as they arrive. */
export const AgentQuery = Context.Reference<
  (params: { prompt: string; options: Options }) => AsyncIterable<unknown>
>("@rpgtl/server/translation/ClaudeLanguageModel/AgentQuery", { defaultValue: () => query });

const ModelUsage = Schema.Struct({
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  cacheReadInputTokens: Schema.Finite,
  cacheCreationInputTokens: Schema.Finite,
  thinkingTokens: Schema.optionalKey(Schema.Finite),
});

/** The messages of a query that RPGTL reads; the SDK sends many others. */
const AgentMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("result"),
    subtype: Schema.Literal("success"),
    is_error: Schema.Boolean,
    result: Schema.String,
    stop_reason: Schema.NullOr(Schema.String),
    total_cost_usd: Schema.Finite,
    modelUsage: Schema.Record(Schema.String, ModelUsage),
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    subtype: Schema.String,
    errors: Schema.Array(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("assistant"), error: Schema.String }),
]);
type AgentMessage = typeof AgentMessage.Type;
type AgentResult = Extract<AgentMessage, { type: "result" }>;
const decodeMessage = Schema.decodeUnknownResult(AgentMessage);

const finishReasons: Record<string, Response.FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  refusal: "content-filter",
};

const failure = (reason: AiError.AiErrorReason) =>
  AiError.make({ module: "ClaudeLanguageModel", method: "generateText", reason });

/** The reason for an error result, from the SDK's code for it. */
const errorReason = (code: string | undefined, said: string | undefined): AiError.AiErrorReason => {
  switch (code) {
    // The subscription's usage window, which resets after some hours.
    case "rate_limit":
      return new AiError.QuotaExhaustedError({});
    case "authentication_failed":
    case "cloud_credential_error":
      return new AiError.AuthenticationError({
        kind: "InvalidKey",
        description: "Claude's login can't be used. Check it with the claude CLI.",
      });
    case "oauth_org_not_allowed":
    case "account_on_hold":
    case "verification_required":
    case "billing_error":
      return new AiError.AuthenticationError({
        kind: "InsufficientPermissions",
        description: "Claude's account can't be used. Check it with the claude CLI.",
      });
    // The SDK has no code for safeguards that flagged the request; only the result's text says so.
    case "invalid_request":
      return said?.includes("safeguards flagged")
        ? new AiError.ContentPolicyError({
            description: "Claude's safeguards flagged the request.",
          })
        : new AiError.UnknownError({ description: "Claude answered with an error." });
    case "overloaded":
    case "server_error":
      return new AiError.InternalProviderError({
        description: "Claude is overloaded or down.",
      });
    default:
      return new AiError.UnknownError({ description: "Claude answered with an error." });
  }
};

const proxyVariables = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"];

export class ClaudeMissingError extends Schema.TaggedError<ClaudeMissingError>()(
  "ClaudeMissingError",
  {},
) {
  override get message() {
    return "Claude Code isn't installed. Install it from https://code.claude.com/docs/en/setup and sign in once with claude in a terminal.";
  }
}

/** The installed `claude` CLI, with the environment and folder it runs in for RPGTL. */
export const claudeCli = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* ChildEnvironment;
  const program = yield* findProgram(yield* ClaudeProgram);
  if (Option.isNone(program)) return yield* new ClaudeMissingError();
  // The CLI runs here, so Claude Code saves its sessions as a project of their own in
  // `~/.claude/projects/`, apart from sessions in the folder RPGTL runs from.
  const cwd = path.join(yield* userStateFolder, "claude-sessions");
  yield* fs.makeDirectory(cwd, { recursive: true });
  // The CLI would otherwise take the calling Claude Code session's settings, such as its effort,
  // and count as part of it; and an API key would be used instead of the subscription. A proxy
  // that holds the subscription login (ANTHROPIC_BASE_URL with ANTHROPIC_AUTH_TOKEN) is kept.
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          (!/^(?:CLAUDE|ANTHROPIC)_/.test(entry[0]) || proxyVariables.includes(entry[0])),
      ),
    ),
    // Requests labelled "sdk-*" use up the 5-hour subscription window about twice as fast as
    // others (https://github.com/pingdotgg/t3code/pull/25597).
    CLAUDE_CODE_ENTRYPOINT: "rpgtl",
    // On a subscription the CLI caches prompts for an hour, and writing that cache costs more than
    // the 5-minute one. A run's requests follow each other within seconds, so 5 minutes is enough.
    CLAUDE_CODE_PROMPT_CACHE_TTL: "5m",
  };
  return { program: program.value, env, cwd };
});

/**
 * Claude through the Agent SDK, which runs the installed `claude` CLI with its login, so a Claude
 * subscription pays for it. The CLI gets no tools, settings, CLAUDE.md files or MCP servers.
 */
const make = Effect.fn("ClaudeLanguageModel.make")(function* (options: { readonly model: string }) {
  const agentQuery = yield* AgentQuery;
  const { program, env, cwd } = yield* claudeCli.pipe(
    Effect.catchTags({
      ClaudeMissingError: (error) =>
        AiError.make({
          module: "ClaudeLanguageModel",
          method: "make",
          reason: new AiError.InternalProviderError({ description: error.message }),
        }),
    }),
  );

  // LanguageModel already gives each request a span.
  const generateText = Effect.fnUntraced(function* (provider: LanguageModel.ProviderOptions) {
    const config = yield* Config;
    const { system, prompt } = agentPrompt(
      yield* textMessages("ClaudeLanguageModel", provider.prompt),
    );
    // Stopping the request stops the CLI.
    const abortController = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) => Effect.sync(() => controller.abort()),
    );
    const queryOptions: Options = {
      model: options.model,
      pathToClaudeCodeExecutable: program,
      env: config.cache === false ? { ...env, DISABLE_PROMPT_CACHING: "1" } : env,
      systemPrompt: system,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      settings: { disableClaudeAiConnectors: true },
      cwd,
      title: `RPGTL translation, ${options.model}`,
      thinking: { type: "adaptive" },
      ...(config.effort !== undefined && isEffortLevel(config.effort) && { effort: config.effort }),
      // The prompts ask for JSON. A JSON schema would make the CLI answer through a tool, which
      // makes Claude think even with thinking off.
      maxTurns: 1,
      abortController,
    };
    const { result, assistantError } = yield* Stream.fromAsyncIterable(
      agentQuery({ prompt, options: queryOptions }),
      (cause) => cause,
    ).pipe(
      Stream.filterMap(decodeMessage),
      // After an error result the CLI exits with an error, which the SDK throws in its place.
      Stream.takeUntil((message) => message.type === "result"),
      Stream.runFold(
        (): { result?: AgentResult; assistantError?: string } => ({}),
        (state, message) =>
          message.type === "result"
            ? { ...state, result: message }
            : { ...state, assistantError: message.error },
      ),
      // The query fails only when the CLI couldn't start or stopped early.
      Effect.tapError((cause) =>
        Effect.logWarning("The Claude CLI stopped without an answer.", cause),
      ),
      Effect.mapError(() =>
        failure(
          new AiError.InternalProviderError({
            description: "The Claude CLI stopped without an answer.",
          }),
        ),
      ),
    );
    if (!result && assistantError === undefined)
      return yield* failure(
        new AiError.InvalidOutputError({ description: "Claude gave no answer." }),
      );
    if (!result || !("is_error" in result) || result.is_error) {
      const said = result && ("is_error" in result ? result.result : result.errors.join("; "));
      yield* Effect.logWarning("Claude answered with an error.", assistantError, said);
      return yield* failure(errorReason(assistantError, said));
    }
    const usage = Object.values(result.modelUsage);
    const sum = (count: (item: (typeof usage)[number]) => number) =>
      usage.reduce((total, item) => total + count(item), 0);
    const output = sum((item) => item.outputTokens);
    const thinking = sum((item) => item.thinkingTokens ?? 0);
    return [
      { type: "text", text: withoutFence(result.result) },
      {
        type: "finish",
        reason: finishReasons[result.stop_reason ?? ""] ?? "other",
        usage: {
          inputTokens: {
            uncached: sum((item) => item.inputTokens),
            total: sum(
              (item) =>
                item.inputTokens + item.cacheReadInputTokens + item.cacheCreationInputTokens,
            ),
            cacheRead: sum((item) => item.cacheReadInputTokens),
            cacheWrite: sum((item) => item.cacheCreationInputTokens),
          },
          outputTokens: { total: output, text: output - thinking, reasoning: thinking },
        },
        metadata: { claude: { costUsd: result.total_cost_usd } },
      },
    ] satisfies Array<Response.PartEncoded>;
  }, Effect.scoped);

  return yield* LanguageModel.make({
    generateText,
    streamText: noStreaming("ClaudeLanguageModel"),
  });
});

export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(LanguageModel.LanguageModel, make(options));

/** Runs `self` with these settings over the current ones, such as a request's over its run's. */
export const withConfigOverride =
  (overrides: ConfigOptions) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.updateService(self, Config, (current) => ({ ...current, ...overrides }));
