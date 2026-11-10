import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ollama from "../localModels/Ollama.ts";

/**
 * An HTTP client where `answer` gets each request's URL and JSON body and gives the response, or
 * none for a server that can't be reached.
 */
export const httpClientAnswering = (
  answer: (url: URL, body: unknown) => Effect.Effect<Option.Option<Response>>,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const body = request.body._tag === "Uint8Array" ? request.body.body : undefined;
        const response = yield* answer(url, body && JSON.parse(new TextDecoder().decode(body)));
        if (Option.isSome(response)) return HttpClientResponse.fromWeb(request, response.value);
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: "connection refused",
          }),
        });
      }),
    ),
  );

/** Ollama over a fake HTTP client that answers as `httpClientAnswering` does. */
export const ollamaAnswering = (
  answer: (url: URL, body: unknown) => Effect.Effect<Option.Option<Response>>,
) => Ollama.layer.pipe(Layer.provide(httpClientAnswering(answer)));

/** Ollama where nothing answers. */
export const ollamaUnreachable = ollamaAnswering(() => Effect.succeedNone);
