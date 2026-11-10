import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

export class OllamaUnreachableError extends Schema.TaggedError<OllamaUnreachableError>()(
  "OllamaUnreachableError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not reach Ollama at ${this.origin}. Is it running?`;
  }
}

/** A model Ollama doesn't have, or whose file it doesn't name. */
export class OllamaModelError extends Schema.TaggedError<OllamaModelError>()("OllamaModelError", {
  model: Schema.String,
  problem: Schema.Literals(["unknown", "noFile"]),
}) {
  override get message() {
    return this.problem === "unknown"
      ? `Ollama has no model named ${this.model}.`
      : `Ollama did not name the model file of ${this.model}.`;
  }
}

/** A model Ollama still keeps in memory after it was asked to unload it. */
export class OllamaHoldsModelError extends Schema.TaggedError<OllamaHoldsModelError>()(
  "OllamaHoldsModelError",
  { model: Schema.String },
) {
  override get message() {
    return `Ollama still holds ${this.model}, so its memory is not free.`;
  }
}

/** A model's files and shape, from what Ollama shows of it. */
export interface ModelFile {
  /** The GGUF file Ollama runs. */
  readonly file: string;
  /** The model's vision part, for a model that reads images. */
  readonly projector: Option.Option<string>;
  readonly blockCount: number;
  /** How many experts each layer has; 0 when it isn't a mixture-of-experts model. */
  readonly expertCount: number;
}

const Shown = Schema.Struct({
  modelfile: Schema.String,
  model_info: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  capabilities: Schema.optionalKey(Schema.Array(Schema.String)),
});

const Tags = Schema.Struct({ models: Schema.Array(Schema.Struct({ name: Schema.String })) });

const Loaded = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      model: Schema.String,
      size: Schema.Finite,
      size_vram: Schema.Finite,
    }),
  ),
});

/**
 * A local Ollama server, reached at the endpoint each call names. Chat requests go through
 * `OllamaLanguageModel`.
 */
export class Ollama extends Context.Service<
  Ollama,
  {
    /** Names of the installed models, sorted. */
    readonly models: (
      endpoint: URL,
    ) => Effect.Effect<ReadonlyArray<string>, OllamaUnreachableError>;
    /**
     * How much of the loaded model runs on the CPU, from 0 to 1; none when Ollama doesn't list it
     * or can't be asked.
     */
    readonly cpuShare: (endpoint: URL, model: string) => Effect.Effect<Option.Option<number>>;
    /**
     * Loads the model with a context of `numCtx` tokens, as a request with that context would.
     * A model that can't be loaded is left to the first request, which says why.
     */
    readonly load: (endpoint: URL, model: string, numCtx: number) => Effect.Effect<void>;
    /** Frees the model's memory now instead of after its keep-alive runs out. */
    readonly unload: (endpoint: URL, model: string) => Effect.Effect<void>;
    /**
     * Unloads the models and waits until Ollama no longer lists them, since it keeps a model for
     * a moment after it answers.
     */
    readonly free: (
      endpoint: URL,
      models: ReadonlyArray<string>,
    ) => Effect.Effect<void, OllamaHoldsModelError>;
    /** Whether the model reads images. */
    readonly readsImages: (
      endpoint: URL,
      model: string,
    ) => Effect.Effect<boolean, OllamaUnreachableError | OllamaModelError>;
    /** The model's GGUF file and shape. */
    readonly modelFile: (
      endpoint: URL,
      model: string,
    ) => Effect.Effect<ModelFile, OllamaUnreachableError | OllamaModelError>;
  }
>()("@rpgtl/server/localModels/Ollama") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const models = Effect.fn("Ollama.models")(function* (endpoint: URL) {
    return yield* client.get(new URL("/api/tags", endpoint)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Tags)),
      Effect.timeout(Duration.seconds(5)),
      Effect.map((tags) => [...new Set(tags.models.map((model) => model.name))].toSorted()),
      Effect.mapError((cause) => new OllamaUnreachableError({ origin: endpoint.origin, cause })),
    );
  });

  const loadedModels = (endpoint: URL) =>
    client
      .get(new URL("/api/ps", endpoint))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Loaded)),
        Effect.timeout(Duration.seconds(10)),
      );

  const cpuShare = Effect.fn("Ollama.cpuShare")(function* (endpoint: URL, model: string) {
    const loaded = yield* loadedModels(endpoint).pipe(
      Effect.asSome,
      // The share only adds a warning to a run, which goes on without it.
      Effect.catchTags({
        HttpClientError: () => Effect.succeedNone,
        SchemaError: () => Effect.succeedNone,
        TimeoutError: () => Effect.succeedNone,
      }),
    );
    return Option.flatMap(loaded, (running) =>
      Option.fromUndefinedOr(
        running.models.find(
          (item) => (item.name === model || item.model === model) && item.size > 0,
        ),
      ).pipe(Option.map((item) => Math.max(0, 1 - item.size_vram / item.size))),
    );
  });

  const load = Effect.fn("Ollama.load")(function* (endpoint: URL, model: string, numCtx: number) {
    // A chat without messages only loads the model.
    yield* HttpClientRequest.post(new URL("/api/chat", endpoint)).pipe(
      HttpClientRequest.bodyJsonUnsafe({ model, messages: [], options: { num_ctx: numCtx } }),
      client.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.catchTags({ HttpClientError: () => Effect.void }),
    );
  });

  const unload = Effect.fn("Ollama.unload")(function* (endpoint: URL, model: string) {
    yield* HttpClientRequest.post(new URL("/api/generate", endpoint)).pipe(
      HttpClientRequest.bodyJsonUnsafe({ model, keep_alive: 0 }),
      client.execute,
      Effect.timeout(Duration.seconds(10)),
      // Ollama still unloads the model once its keep-alive runs out.
      Effect.catchTags({
        HttpClientError: (error) => Effect.logWarning("Couldn't unload the model.", error),
        TimeoutError: (error) => Effect.logWarning("Couldn't unload the model.", error),
      }),
    );
  });

  const free = Effect.fn("Ollama.free")(function* (endpoint: URL, names: ReadonlyArray<string>) {
    yield* Effect.forEach(names, (model) => unload(endpoint, model), { discard: true });
    const stillHeld = loadedModels(endpoint).pipe(
      Effect.map((loaded) =>
        names.find((model) =>
          loaded.models.some((item) => item.name === model || item.model === model),
        ),
      ),
      // An Ollama that can't be asked holds no memory a later server could need.
      Effect.catchTags({
        HttpClientError: () => Effect.undefined,
        SchemaError: () => Effect.undefined,
        TimeoutError: () => Effect.undefined,
      }),
      Effect.flatMap((held) =>
        held === undefined ? Effect.void : Effect.fail(new OllamaHoldsModelError({ model: held })),
      ),
    );
    yield* Effect.retry(
      stillHeld,
      Schedule.spaced(Duration.millis(250)).pipe(Schedule.upTo({ duration: Duration.seconds(30) })),
    );
  });

  const show = Effect.fnUntraced(function* (endpoint: URL, model: string) {
    const response = yield* HttpClientRequest.post(new URL("/api/show", endpoint)).pipe(
      HttpClientRequest.bodyJsonUnsafe({ model }),
      client.execute,
      Effect.timeout(Duration.seconds(10)),
      Effect.mapError((cause) => new OllamaUnreachableError({ origin: endpoint.origin, cause })),
    );
    if (response.status === 404) return yield* new OllamaModelError({ model, problem: "unknown" });
    return yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Shown)),
      Effect.mapError((cause) => new OllamaUnreachableError({ origin: endpoint.origin, cause })),
    );
  });

  const readsImages = Effect.fn("Ollama.readsImages")(function* (endpoint: URL, model: string) {
    const shown = yield* show(endpoint, model);
    return shown.capabilities?.includes("vision") ?? false;
  });

  const modelFile = Effect.fn("Ollama.modelFile")(function* (endpoint: URL, model: string) {
    const shown = yield* show(endpoint, model);
    // The first FROM line names the model; a model that reads images has a second for its vision
    // part.
    const [file, projector] = Array.from(
      shown.modelfile.matchAll(/^FROM (\/.+)$/gm),
      (match) => match[1]?.trim() ?? "",
    );
    if (!file) return yield* new OllamaModelError({ model, problem: "noFile" });
    const info = shown.model_info ?? {};
    const count = (suffix: string) => {
      const value = Object.entries(info).find(([key]) => key.endsWith(suffix))?.[1];
      return typeof value === "number" ? value : 0;
    };
    return {
      file,
      projector: Option.fromUndefinedOr(projector || undefined),
      blockCount: count(".block_count"),
      expertCount: count(".expert_count"),
    } satisfies ModelFile;
  });

  return Ollama.of({ models, cpuShare, load, unload, free, readsImages, modelFile });
});

export const layer = Layer.effect(Ollama, make);
