import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { alive } from "../testUtils/llama.ts";
import { ChildEnvironment } from "./ChildEnvironment.ts";
import * as CodexLanguageModel from "./CodexLanguageModel.ts";
import { prompt, reasonOf } from "../testUtils/languageModel.ts";

class TempDir extends Context.Service<TempDir, string>()("@rpgtl/server/translation/TempDir") {}

/**
 * `model` on the fake CLI in `testUtils/fakeCodex.ts`, with a new user state folder; the model picks
 * what the CLI does.
 */
const fakeCodex = (
  model: string,
  environment: Record<string, string> = {},
  command = process.execPath,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      return CodexLanguageModel.layer({ model }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CodexLanguageModel.CodexCommand, {
              command,
              args: [path.join(import.meta.dirname, "../testUtils/fakeCodex.ts")],
            }),
            Layer.succeed(ChildEnvironment, {
              PATH: "/usr/bin",
              OPENAI_API_KEY: "key",
              CODEX_HOME: "/elsewhere",
              FAKE_CODEX_PID: path.join(dir, "pid"),
              ...environment,
            }),
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ XDG_STATE_HOME: dir, HOME: "/nowhere" }),
            ),
          ),
        ),
        Layer.merge(Layer.succeed(TempDir, dir)),
      );
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

it.live("asks with the prompt on stdin, in RPGTL's own home and without an API key", () =>
  Effect.gen(function* () {
    const dir = yield* TempDir;
    const response = yield* LanguageModel.generateText({ prompt }).pipe(
      CodexLanguageModel.withConfigOverride({ effort: "low" }),
    );
    assert.deepStrictEqual(JSON.parse(response.text), {
      stdin: "你好",
      instructions: 'instructions="Translate."',
      effort: 'model_reasoning_effort="low"',
      home: `${dir}/rpgtl/codex`,
    });
    assert.strictEqual(response.usage.inputTokens.total, 100);
    assert.deepStrictEqual(response.usage.outputTokens, { total: 30, text: 10, reasoning: 20 });
  }).pipe(Effect.provide(fakeCodex("answer"))),
);

it.live("a failed turn at the usage limit is a used-up quota", () =>
  Effect.gen(function* () {
    const reason = yield* reasonOf(LanguageModel.generateText({ prompt }));
    assert.strictEqual(reason._tag, "QuotaExhaustedError");
  }).pipe(Effect.provide(fakeCodex("fail"))),
);

it.live("without a login Codex can't be used at all", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(fakeCodex("answer", { FAKE_CODEX_LOGGED_OUT: "1" })),
    );
    assert.isTrue(
      error._tag === "AiError" &&
        error.reason._tag === "AuthenticationError" &&
        error.reason.kind === "MissingKey",
    );
  }),
);

it.live("without codex on PATH Codex can't be used at all", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(Layer.build(fakeCodex("answer", {}, "codex")));
    assert.isTrue(
      error._tag === "AiError" &&
        error.reason._tag === "InternalProviderError" &&
        /isn't installed/.test(error.reason.description ?? ""),
    );
  }),
);

it.live("stopping a request stops the CLI, and no error escapes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* TempDir;
    const started = yield* fs.watch(dir).pipe(
      Stream.filter((event) => event.path.endsWith("pid")),
      Stream.runHead,
      Effect.forkChild,
    );
    const fiber = yield* Effect.forkChild(LanguageModel.generateText({ prompt }));
    yield* Fiber.join(started);
    const pid = Number(yield* fs.readFileString(`${dir}/pid`));
    assert.isTrue(yield* alive(pid));
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    assert.isFalse(yield* alive(pid));
  }).pipe(Effect.provide(fakeCodex("hang"))),
);
