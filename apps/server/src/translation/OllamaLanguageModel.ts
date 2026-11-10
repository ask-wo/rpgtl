import * as AiError from "effect/ai/AiError";
import * as LanguageModel from "effect/ai/LanguageModel";
import type * as Response from "effect/ai/Response";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { noStreaming, textMessages } from "./prompt.ts";

declare module "effect/ai/Response" {
  export interface FinishPartMetadata {
    readonly ollama?: {
      readonly promptMs: number | null;
      readonly outputMs: number | null;
    } | null;
  }
}

/** Sampling and room for a chat request, as Ollama's `options` takes them. */
interface OllamaOptions {
  readonly temperature?: number;
  readonly top_p?: number;
  readonly top_k?: number;
  readonly repeat_penalty?: number;
  readonly min_p?: number;
  readonly presence_penalty?: number;
  /** Tokens of context the model is loaded with. */
  readonly num_ctx?: number;
  /** Most tokens the answer may have. */
  readonly num_predict?: number;
}

export interface ConfigOptions {
  /** Whether the model thinks before it answers; Ollama's default when unset. */
  readonly think?: boolean;
  readonly options?: OllamaOptions;
}

/** Settings for the requests inside it; set them with `withConfigOverride`. */
const Config = Context.Reference<ConfigOptions>(
  "@rpgtl/server/translation/OllamaLanguageModel/Config",
  { defaultValue: () => ({}) },
);

const ChatResponse = Schema.Struct({
  message: Schema.Struct({
    content: Schema.String,
    thinking: Schema.optionalKey(Schema.String),
  }),
  done_reason: Schema.optionalKey(Schema.String),
  prompt_eval_count: Schema.optionalKey(Schema.Finite),
  /** In nanoseconds, as the other durations. */
  prompt_eval_duration: Schema.optionalKey(Schema.Finite),
  eval_count: Schema.optionalKey(Schema.Finite),
  eval_duration: Schema.optionalKey(Schema.Finite),
});

const nanosToMs = (nanos: number | undefined) => (nanos === undefined ? null : nanos / 1e6);

const finishReasons: Record<string, Response.FinishReason> = { stop: "stop", length: "length" };

const failure = (reason: AiError.AiErrorReason) =>
  AiError.make({ module: "OllamaLanguageModel", method: "generateText", reason });

const mapHttpClientError = Effect.fnUntraced(function* (error: HttpClientError.HttpClientError) {
  const reason = error.reason;
  if (reason._tag === "StatusCodeError") {
    const status = reason.response.status;
    const body = yield* reason.response.text.pipe(
      Effect.catchTags({ HttpClientError: () => Effect.succeed("") }),
    );
    // Ollama names the problem, such as an unknown model, in the body.
    yield* Effect.logWarning(`Ollama answered with HTTP ${status}.`, body);
    return yield* failure(
      status === 404
        ? new AiError.InvalidRequestError({
            parameter: "model",
            description: "Ollama doesn't have this model.",
          })
        : AiError.reasonFromHttpStatus({ status }),
    );
  }
  if (reason._tag === "DecodeError" || reason._tag === "EmptyBodyError")
    return yield* failure(
      new AiError.InvalidOutputError({
        description: reason.description ?? "Ollama's answer couldn't be read.",
      }),
    );
  return yield* failure(
    new AiError.NetworkError({
      reason: reason._tag,
      method: reason.request.method,
      url: reason.request.url,
      description: reason.description,
      cause: error,
    }),
  );
});

/**
 * A model on the local Ollama server at `endpoint`, asked through `/api/chat`, with `config` under
 * the settings `withConfigOverride` gives.
 */
const make = Effect.fn("OllamaLanguageModel.make")(function* (options: {
  readonly endpoint: URL;
  readonly model: string;
  readonly config?: ConfigOptions;
}) {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const url = new URL("/api/chat", options.endpoint);

  // LanguageModel already gives each request a span.
  const generateText = Effect.fnUntraced(function* (provider: LanguageModel.ProviderOptions) {
    const current = yield* Config;
    const think = current.think ?? options.config?.think;
    const ollamaOptions =
      options.config?.options || current.options
        ? { ...options.config?.options, ...current.options }
        : undefined;
    const messages = yield* textMessages("OllamaLanguageModel", provider.prompt, { images: true });
    const { responseFormat } = provider;
    const format =
      responseFormat.type === "json"
        ? yield* Effect.try({
            try: () => {
              // Ollama keeps the answer to this grammar, so it allows no keys the schema lacks.
              const document = Schema.toJsonSchemaDocument(responseFormat.schema, {
                onExcessProperty: "error",
              });
              return Object.keys(document.definitions).length > 0
                ? { ...document.schema, $defs: document.definitions }
                : document.schema;
            },
            catch: (error) =>
              failure(new AiError.UnsupportedSchemaError({ description: String(error) })),
          })
        : undefined;
    const answer = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        model: options.model,
        messages,
        ...(format && { format }),
        ...(think !== undefined && { think }),
        ...(ollamaOptions && { options: ollamaOptions }),
        stream: false,
        keep_alive: "30m",
      }),
      client.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ChatResponse)),
      Effect.catchTags({
        HttpClientError: mapHttpClientError,
        SchemaError: (error) => failure(AiError.InvalidOutputError.fromSchemaError(error)),
      }),
    );
    const parts: Array<Response.PartEncoded> = [];
    if (answer.message.thinking) parts.push({ type: "reasoning", text: answer.message.thinking });
    parts.push({ type: "text", text: answer.message.content });
    parts.push({
      type: "finish",
      reason: finishReasons[answer.done_reason ?? ""] ?? "other",
      usage: {
        // Ollama counts only the prompt tokens it didn't have cached.
        inputTokens: { uncached: answer.prompt_eval_count, total: undefined },
        outputTokens: {
          total: answer.eval_count,
          text: answer.message.thinking ? undefined : answer.eval_count,
        },
      },
      metadata: {
        ollama: {
          promptMs: nanosToMs(answer.prompt_eval_duration),
          outputMs: nanosToMs(answer.eval_duration),
        },
      },
    });
    return parts;
  });

  return yield* LanguageModel.make({
    generateText,
    streamText: noStreaming("OllamaLanguageModel"),
  });
});

export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(LanguageModel.LanguageModel, make(options));

/** Runs `self` with these settings over the current ones, such as a request's over its run's. */
export const withConfigOverride =
  (overrides: ConfigOptions) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.updateService(self, Config, (current) => ({
      ...current,
      ...overrides,
      options: { ...current.options, ...overrides.options },
    }));
