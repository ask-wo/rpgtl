import { assert, it } from "@effect/vitest";
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { httpClientAnswering } from "../testUtils/ollama.ts";
import * as OllamaLanguageModel from "./OllamaLanguageModel.ts";
import { Answer, prompt, reasonOf } from "../testUtils/languageModel.ts";

/** Qwen on Ollama over a fake HTTP client that answers as `httpClientAnswering` does. */
const qwenAnswering = (answer: Parameters<typeof httpClientAnswering>[0]) =>
  OllamaLanguageModel.layer({ endpoint: new URL("http://127.0.0.1:11434"), model: "qwen" }).pipe(
    Layer.provide(httpClientAnswering(answer)),
  );

it.effect(
  "asks for the whole answer in its schema, with the run's and the request's settings",
  () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<unknown>(undefined);
      const response = yield* LanguageModel.generateObject({ prompt, schema: Answer }).pipe(
        OllamaLanguageModel.withConfigOverride({ options: { num_predict: 100 } }),
        OllamaLanguageModel.withConfigOverride({
          think: false,
          options: { temperature: 0, num_ctx: 4096 },
        }),
        Effect.provide(
          qwenAnswering((url, body) =>
            Ref.set(sent, { path: url.pathname, body }).pipe(
              Effect.as(
                Option.some(
                  Response.json({
                    message: { content: '{"1":"Hello"}' },
                    done_reason: "stop",
                    prompt_eval_count: 50,
                    prompt_eval_duration: 2_000_000,
                    eval_count: 5,
                    eval_duration: 3_000_000,
                  }),
                ),
              ),
            ),
          ),
        ),
      );
      assert.deepStrictEqual(yield* Ref.get(sent), {
        path: "/api/chat",
        body: {
          model: "qwen",
          messages: prompt,
          format: {
            type: "object",
            properties: { "1": { type: "string" } },
            required: ["1"],
            additionalProperties: false,
          },
          think: false,
          options: { temperature: 0, num_ctx: 4096, num_predict: 100 },
          stream: false,
          keep_alive: "30m",
        },
      });
      assert.deepStrictEqual(response.value, { "1": "Hello" });
      assert.strictEqual(response.finishReason, "stop");
      assert.strictEqual(response.usage.inputTokens.uncached, 50);
      assert.strictEqual(response.usage.outputTokens.text, 5);
      const finish = response.content.find((part) => part.type === "finish");
      assert.deepStrictEqual(finish?.metadata.ollama, { promptMs: 2, outputMs: 3 });
    }),
);

it.effect("sends an image as base64 with its message's text", () =>
  Effect.gen(function* () {
    const sent = yield* Ref.make<unknown>(undefined);
    yield* LanguageModel.generateText({
      prompt: [
        {
          role: "user",
          content: [
            { type: "file", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
            { type: "text", text: "Read the text." },
          ],
        },
      ],
    }).pipe(
      Effect.provide(
        qwenAnswering((_url, body) =>
          Ref.set(sent, body).pipe(
            Effect.as(Option.some(Response.json({ message: { content: "Hello" } }))),
          ),
        ),
      ),
    );
    assert.deepInclude(yield* Ref.get(sent), {
      messages: [{ role: "user", content: "Read the text.", images: ["AQID"] }],
    });
  }),
);

it.effect("an unknown model is an invalid request naming the model", () =>
  Effect.gen(function* () {
    const missing = yield* reasonOf(LanguageModel.generateText({ prompt }));
    assert.strictEqual(missing._tag === "InvalidRequestError" && missing.parameter, "model");
  }).pipe(
    Effect.provide(
      qwenAnswering(() =>
        Effect.succeedSome(Response.json({ error: "model 'qwen' not found" }, { status: 404 })),
      ),
    ),
  ),
);

it.effect("a server error is the provider's, and no server at all a network error", () =>
  Effect.gen(function* () {
    const failing = yield* reasonOf(
      LanguageModel.generateText({ prompt }).pipe(
        Effect.provide(
          qwenAnswering(() => Effect.succeedSome(new Response("oops", { status: 500 }))),
        ),
      ),
    );
    assert.strictEqual(failing._tag, "InternalProviderError");
    const gone = yield* reasonOf(
      LanguageModel.generateText({ prompt }).pipe(
        Effect.provide(qwenAnswering(() => Effect.succeedNone)),
      ),
    );
    assert.strictEqual(gone._tag, "NetworkError");
  }),
);

it.effect("an answer that doesn't fit its schema is an error that keeps the answer", () =>
  Effect.gen(function* () {
    const reason = yield* reasonOf(LanguageModel.generateObject({ prompt, schema: Answer }));
    assert.strictEqual(reason._tag, "StructuredOutputError");
    assert.strictEqual(reason._tag === "StructuredOutputError" && reason.responseText, "Hello");
  }).pipe(
    Effect.provide(
      qwenAnswering(() => Effect.succeedSome(Response.json({ message: { content: "Hello" } }))),
    ),
  ),
);

it.effect("stopping a request stops waiting for its answer", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const fiber = yield* LanguageModel.generateText({ prompt }).pipe(
      Effect.provide(
        qwenAnswering(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        ),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    yield* Deferred.await(interrupted);
  }),
);
