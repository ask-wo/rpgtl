import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { ollamaAnswering, ollamaUnreachable } from "../testUtils/ollama.ts";
import * as Ollama from "./Ollama.ts";

const endpoint = new URL("http://127.0.0.1:11434");

it.effect("lists each installed model once, sorted", () =>
  Effect.gen(function* () {
    const ollama = yield* Ollama.Ollama;
    assert.deepStrictEqual(yield* ollama.models(endpoint), ["a:1b", "b:7b"]);
  }).pipe(
    Effect.provide(
      ollamaAnswering(() =>
        Effect.succeedSome(
          Response.json({ models: [{ name: "b:7b" }, { name: "a:1b" }, { name: "b:7b" }] }),
        ),
      ),
    ),
  ),
);

it.effect("a server that can't be reached or isn't Ollama is unreachable", () =>
  Effect.gen(function* () {
    const ollama = yield* Ollama.Ollama;
    const error = yield* Effect.flip(ollama.models(endpoint));
    assert.strictEqual(error._tag, "OllamaUnreachableError");
    assert.strictEqual(error.origin, "http://127.0.0.1:11434");
  }).pipe(Effect.provide(ollamaUnreachable)),
);

it.effect("tells how much of a loaded model runs on the CPU", () =>
  Effect.gen(function* () {
    const ollama = yield* Ollama.Ollama;
    assert.deepStrictEqual(yield* ollama.cpuShare(endpoint, "qwen"), Option.some(0.25));
    assert.deepStrictEqual(yield* ollama.cpuShare(endpoint, "other"), Option.none());
  }).pipe(
    Effect.provide(
      ollamaAnswering(() =>
        Effect.succeedSome(
          Response.json({
            models: [{ name: "qwen", model: "qwen", size: 400, size_vram: 300 }],
          }),
        ),
      ),
    ),
  ),
);

it.effect("names a model's file, vision part, layers and experts", () =>
  Effect.gen(function* () {
    const ollama = yield* Ollama.Ollama;
    assert.deepStrictEqual(yield* ollama.modelFile(endpoint, "qwen"), {
      file: "/models/qwen.gguf",
      projector: Option.some("/models/vision.gguf"),
      blockCount: 40,
      expertCount: 256,
    });
    const unknown = yield* Effect.flip(ollama.modelFile(endpoint, "gone"));
    assert.include(unknown, { _tag: "OllamaModelError", problem: "unknown" });
  }).pipe(
    Effect.provide(
      ollamaAnswering((_, body) =>
        Effect.succeedSome(
          typeof body === "object" && body && "model" in body && body.model === "qwen"
            ? Response.json({
                modelfile: "# comment\nFROM /models/qwen.gguf\nFROM /models/vision.gguf\n",
                model_info: { "qwen35moe.block_count": 40, "qwen35moe.expert_count": 256 },
              })
            : Response.json({ error: "model 'gone' not found" }, { status: 404 }),
        ),
      ),
    ),
  ),
);

it.effect("freeing models unloads them and waits until Ollama no longer holds them", () =>
  Effect.gen(function* () {
    const asked = yield* Ref.make(0);
    const unloaded = yield* Ref.make<ReadonlyArray<string>>([]);
    const ollama = yield* Ollama.Ollama.pipe(
      Effect.provide(
        ollamaAnswering((url, body) =>
          Effect.gen(function* () {
            if (url.pathname === "/api/generate") {
              const model =
                typeof body === "object" && body && "model" in body ? String(body.model) : "";
              yield* Ref.update(unloaded, (models) => [...models, model]);
              return Option.some(Response.json({}));
            }
            // Ollama lists the model for the first three checks.
            const checks = yield* Ref.getAndUpdate(asked, (count) => count + 1);
            const models =
              checks < 3 ? [{ name: "qwen", model: "qwen", size: 1, size_vram: 1 }] : [];
            return Option.some(Response.json({ models }));
          }),
        ),
      ),
    );
    const freeing = yield* Effect.forkChild(ollama.free(endpoint, ["qwen", "names"]));
    yield* TestClock.adjust(Duration.millis(500));
    assert.isUndefined(freeing.pollUnsafe());
    yield* TestClock.adjust(Duration.millis(250));
    yield* Fiber.join(freeing);
    assert.deepStrictEqual(yield* Ref.get(unloaded), ["qwen", "names"]);

    // A model Ollama keeps holding fails after 30 seconds.
    yield* Ref.set(asked, -1000);
    const holding = yield* Effect.forkChild(Effect.flip(ollama.free(endpoint, ["qwen"])));
    yield* TestClock.adjust(Duration.seconds(31));
    assert.include(yield* Fiber.join(holding), { _tag: "OllamaHoldsModelError", model: "qwen" });
  }),
);

it.effect(
  "loading a model asks for it with the run's context, and leaves a failure to the run",
  () =>
    Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const ollama = yield* Ollama.Ollama.pipe(
        Effect.provide(
          ollamaAnswering((url, body) =>
            Effect.gen(function* () {
              yield* Ref.update(asked, (bodies) => [...bodies, body]);
              const known =
                url.pathname === "/api/chat" &&
                typeof body === "object" &&
                body !== null &&
                "model" in body &&
                body.model === "qwen";
              return Option.some(
                known
                  ? Response.json({ done: true })
                  : Response.json({ error: "no" }, { status: 404 }),
              );
            }),
          ),
        ),
      );
      yield* ollama.load(endpoint, "qwen", 8192);
      yield* ollama.load(endpoint, "missing", 8192);
      assert.deepStrictEqual(yield* Ref.get(asked), [
        { model: "qwen", messages: [], options: { num_ctx: 8192 } },
        { model: "missing", messages: [], options: { num_ctx: 8192 } },
      ]);
    }),
);
