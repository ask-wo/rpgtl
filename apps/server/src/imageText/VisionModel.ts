import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel";
import type * as LanguageModel from "effect/ai/LanguageModel";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as LlamaServer from "../localModels/LlamaServer.ts";
import * as Ollama from "../localModels/Ollama.ts";
import * as OllamaLanguageModel from "../translation/OllamaLanguageModel.ts";

/** A model that reads images, ready for requests while its scope lasts. */
export interface StartedVisionModel {
  readonly model: Context.Context<LanguageModel.LanguageModel>;
  /** Why the model's server ended, or none while it runs; always none on Ollama. */
  readonly ended: LlamaServer.RunningServer["ended"];
}

/**
 * The fallback reader's model: an Ollama model that reads images, one request at a time and at
 * temperature 0. It runs in llama-server with its vision part when expert layers in system RAM
 * are given, and on Ollama itself without, which places the model in memory on its own.
 */
export class VisionModel extends Context.Service<
  VisionModel,
  {
    /**
     * Starts Ollama's `model`, freeing it in Ollama first, and stops it when the scope closes. On
     * Ollama it loads the model, and unloads it when the scope closes.
     */
    readonly start: (options: {
      readonly endpoint: URL;
      readonly model: string;
      /** The least expert layers llama-server keeps in system RAM; Ollama runs it without. */
      readonly expertLayersInRam?: number;
      readonly log: string;
    }) => Effect.Effect<StartedVisionModel, LlamaServer.ServeError, Scope.Scope>;
  }
>()("@rpgtl/server/imageText/VisionModel") {}

const make = Effect.gen(function* () {
  const llamaServer = yield* LlamaServer.LlamaServer;
  const ollama = yield* Ollama.Ollama;
  const client = yield* HttpClient.HttpClient;
  const numCtx = 8192;

  const start = Effect.fn("VisionModel.start")(function* (
    options: Parameters<VisionModel["Service"]["start"]>[0],
  ) {
    if (options.expertLayersInRam === undefined) {
      if (!(yield* ollama.readsImages(options.endpoint, options.model)))
        return yield* new LlamaServer.NoVisionError({ model: options.model });
      // Freed when the scope closes, since the image reader reads the crops next.
      yield* Effect.addFinalizer(() => ollama.unload(options.endpoint, options.model));
      yield* ollama.load(options.endpoint, options.model, numCtx);
      const model = yield* Layer.build(
        OllamaLanguageModel.layer({
          endpoint: options.endpoint,
          model: options.model,
          config: { think: false, options: { temperature: 0, num_ctx: numCtx } },
        }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      );
      return { model, ended: Effect.succeedNone } satisfies StartedVisionModel;
    }
    const server = yield* llamaServer.serve({
      endpoint: options.endpoint,
      model: options.model,
      unload: [options.model],
      expertLayersInRam: options.expertLayersInRam,
      slots: 1,
      numCtx,
      log: options.log,
      vision: true,
    });
    const model = yield* Layer.build(
      OpenAiLanguageModel.layer({ model: options.model, config: { temperature: 0 } }).pipe(
        Layer.provide(OpenAiClient.layer({ apiUrl: server.api.href })),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      ),
    );
    return { model, ended: server.ended } satisfies StartedVisionModel;
  });

  return VisionModel.of({ start });
});

export const layer = Layer.effect(VisionModel, make);
