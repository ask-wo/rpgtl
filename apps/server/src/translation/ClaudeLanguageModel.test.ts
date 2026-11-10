import * as NodeServices from "@effect/platform-node/NodeServices";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { dirname } from "node:path";
import { assert, it } from "@effect/vitest";
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildEnvironment } from "./ChildEnvironment.ts";
import { messagesOf } from "../testUtils/agentQuery.ts";
import * as ClaudeLanguageModel from "./ClaudeLanguageModel.ts";
import { Answer, prompt, reasonOf } from "../testUtils/languageModel.ts";

const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: '```json\n{"1":"Hello"}\n```',
  stop_reason: "end_turn",
  total_cost_usd: 0.01,
  modelUsage: {
    "claude-opus-5-5": {
      inputTokens: 10,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 30,
      outputTokens: 50,
      thinkingTokens: 8,
    },
  },
};

class AgentDir extends Context.Service<AgentDir, string>()("@rpgtl/server/translation/AgentDir") {}

/** Where the fake CLI's `node` is, for the real SDK to start it. */
const nodeDir = dirname(process.execPath);

/** Opus over a fake SDK that answers each query with `answer`, in a new user state folder. */
const claudeAnswering = (
  answer: (params: { prompt: string; options: Options }) => AsyncIterable<unknown>,
  program = process.execPath,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      return ClaudeLanguageModel.layer({ model: "claude-opus-5-5" }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ClaudeLanguageModel.AgentQuery, answer),
            Layer.succeed(ClaudeLanguageModel.ClaudeProgram, program),
            Layer.succeed(ChildEnvironment, {
              PATH: nodeDir,
              CLAUDE_CODE_EFFORT: "max",
              ANTHROPIC_API_KEY: "key",
              ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
              ANTHROPIC_AUTH_TOKEN: "proxy",
              FAKE_AGENT_DIR: dir,
            }),
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ XDG_STATE_HOME: dir, HOME: "/nowhere" }),
            ),
          ),
        ),
        Layer.merge(Layer.succeed(AgentDir, dir)),
      );
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

/** Claude through the real SDK, which starts `testUtils/fakeClaude.ts` in place of its CLI. */
const withFakeCli = claudeAnswering((params) =>
  query({
    ...params,
    options: {
      ...params.options,
      pathToClaudeCodeExecutable: `${import.meta.dirname}/../testUtils/fakeClaude.ts`,
      executable: "node",
    },
  }),
);

it.effect("asks with one prompt and no tools or settings, on the subscription", () => {
  const queries: Array<{ prompt: string; options: Options }> = [];
  return Effect.gen(function* () {
    const dir = yield* AgentDir;
    const response = yield* LanguageModel.generateObject({ prompt, schema: Answer }).pipe(
      ClaudeLanguageModel.withConfigOverride({ cache: false }),
    );
    assert.deepStrictEqual(response.value, { "1": "Hello" });
    assert.strictEqual(response.finishReason, "stop");
    assert.deepStrictEqual(response.usage.inputTokens, {
      uncached: 10,
      total: 60,
      cacheRead: 20,
      cacheWrite: 30,
    });
    assert.deepStrictEqual(response.usage.outputTokens, { total: 50, text: 42, reasoning: 8 });
    const finish = response.content.find((part) => part.type === "finish");
    assert.deepStrictEqual(finish?.metadata.claude, { costUsd: 0.01 });
    const [asked] = queries;
    assert.isDefined(asked);
    const { options } = asked;
    assert.strictEqual(asked.prompt, "你好");
    assert.strictEqual(options.systemPrompt, "Translate.");
    assert.deepStrictEqual(options.tools, []);
    assert.deepStrictEqual(options.settingSources, []);
    assert.deepStrictEqual(options.thinking, { type: "adaptive" });
    assert.deepStrictEqual(options.env, {
      PATH: nodeDir,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
      ANTHROPIC_AUTH_TOKEN: "proxy",
      CLAUDE_CODE_ENTRYPOINT: "rpgtl",
      CLAUDE_CODE_PROMPT_CACHE_TTL: "5m",
      DISABLE_PROMPT_CACHING: "1",
      FAKE_AGENT_DIR: dir,
    });
    assert.match(options.cwd ?? "", /\/rpgtl\/claude-sessions$/);
  }).pipe(
    Effect.provide(
      claudeAnswering((params) => {
        queries.push(params);
        return messagesOf([{ type: "system", subtype: "init" }, success]);
      }),
    ),
  );
});

it.effect("without Claude Code on PATH Claude can't be used at all", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(claudeAnswering(() => messagesOf([success]), "claude")),
    );
    assert.isTrue(
      error._tag === "AiError" &&
        error.reason._tag === "InternalProviderError" &&
        /isn't installed/.test(error.reason.description ?? ""),
    );
  }),
);

it.effect("the usage limit, an error result and no result at all are each their own error", () =>
  Effect.gen(function* () {
    const limit = yield* reasonOf(LanguageModel.generateText({ prompt: "limit" }));
    assert.strictEqual(limit._tag, "QuotaExhaustedError");
    const failed = yield* reasonOf(LanguageModel.generateText({ prompt: "fail" }));
    assert.strictEqual(failed._tag, "UnknownError");
    const nothing = yield* reasonOf(LanguageModel.generateText({ prompt }));
    assert.strictEqual(nothing._tag, "InvalidOutputError");
  }).pipe(
    Effect.provide(
      claudeAnswering(({ prompt: asked }) =>
        messagesOf(
          asked === "fail"
            ? [{ ...success, is_error: true, result: "Claude failed" }]
            : asked === "limit"
              ? [
                  { type: "assistant", error: "rate_limit" },
                  { ...success, is_error: true, result: "You've hit your limit" },
                ]
              : [],
          asked === "fail" || asked === "limit"
            ? new Error("Claude Code returned an error result")
            : undefined,
        ),
      ),
    ),
  ),
);

it.live("stopping a request stops the CLI, and no error escapes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* AgentDir;
    const marked = (name: string) =>
      fs.watch(dir).pipe(
        Stream.filter((event) => event.path.endsWith(name)),
        Stream.runHead,
        Effect.forkChild,
      );
    const started = yield* marked("started");
    const stopped = yield* marked("stopped");
    const fiber = yield* Effect.forkChild(LanguageModel.generateText({ prompt }));
    yield* Fiber.join(started);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    yield* Fiber.join(stopped);
  }).pipe(Effect.provide(withFakeCli)),
);
