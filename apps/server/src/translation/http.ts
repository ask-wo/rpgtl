import {
  AgentModelsUnavailable,
  Api,
  EndpointRejected,
  GameBusy,
  GameNotInspected,
  OllamaModelMissing,
  OllamaUnreachable,
} from "@rpgtl/contracts";
import { localEndpoint } from "@rpgtl/domain";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { stateFileFailed } from "../state/http.ts";
import * as LlamaServer from "../localModels/LlamaServer.ts";
import type * as Config from "effect/Config";
import type * as PlatformError from "effect/PlatformError";
import * as AgentModels from "./AgentModels.ts";
import type { ClaudeMissingError } from "./ClaudeLanguageModel.ts";
import type { CodexMissingError } from "./CodexLanguageModel.ts";
import * as Ollama from "../localModels/Ollama.ts";
import * as Runs from "./Runs.ts";

const notInspected = () => Effect.fail(new GameNotInspected());

// HttpApi answers a query it can't decode with an empty 400, so the endpoint is checked here to
// tell the page what is wrong with it.
const checkedEndpoint = (text: string) =>
  Effect.fromResult(
    Result.mapError(localEndpoint(text), (problem) => EndpointRejected.because(problem)),
  );
const ollamaUnreachable = (error: Ollama.OllamaUnreachableError) =>
  Effect.logWarning(error.message, error.cause).pipe(
    Effect.andThen(Effect.fail(OllamaUnreachable.at(error.origin))),
  );

const OllamaHandlers = HttpApiBuilder.group(
  Api,
  "ollama",
  Effect.fnUntraced(function* (handlers) {
    const ollama = yield* Ollama.Ollama;
    const llamaServer = yield* LlamaServer.LlamaServer;
    return handlers.handleAll({
      models: Effect.fn("ollama.models")(function* ({ query }) {
        const endpoint = yield* checkedEndpoint(query.endpoint);
        return yield* ollama
          .models(endpoint)
          .pipe(Effect.catchTags({ OllamaUnreachableError: ollamaUnreachable }));
      }),
      modelInfo: Effect.fn("ollama.modelInfo")(function* ({ query }) {
        const endpoint = yield* checkedEndpoint(query.endpoint);
        const { blockCount, expertCount } = yield* ollama.modelFile(endpoint, query.model).pipe(
          Effect.catchTags({
            OllamaUnreachableError: ollamaUnreachable,
            OllamaModelError: (error) =>
              Effect.fail(OllamaModelMissing.because(error.model, error.problem)),
          }),
        );
        return { blockCount, expertCount };
      }),
      llamaServer: () =>
        llamaServer.unavailable.pipe(
          Effect.map(
            Option.match({ onNone: () => ({}), onSome: (unavailable) => ({ unavailable }) }),
          ),
        ),
    });
  }),
);

const modelsUnavailable =
  (translator: "claude" | "codex") =>
  (
    error:
      | AgentModels.AgentModelsError
      | ClaudeMissingError
      | CodexMissingError
      | PlatformError.PlatformError
      | Config.ConfigError,
  ) =>
    Effect.logWarning(`${translator} didn't list its models.`, error).pipe(
      Effect.andThen(
        Effect.fail(
          AgentModelsUnavailable.because(
            translator,
            error._tag === "ClaudeMissingError" || error._tag === "CodexMissingError"
              ? "missing"
              : error._tag === "AgentModelsError" && error.problem === "loggedOut"
                ? "loggedOut"
                : "failed",
          ),
        ),
      ),
    );

const AgentsHandlers = HttpApiBuilder.group(
  Api,
  "agents",
  Effect.fnUntraced(function* (handlers) {
    const agentModels = yield* AgentModels.AgentModels;
    return handlers.handleAll({
      models: ({ query }) =>
        query.translator === "claude"
          ? agentModels.claude.pipe(
              // oxlint-disable-next-line rpgtl/no-catch-all -- every failure leaves the page without a list
              Effect.catch(modelsUnavailable("claude")),
            )
          : agentModels.codex.pipe(
              // oxlint-disable-next-line rpgtl/no-catch-all -- every failure leaves the page without a list
              Effect.catch(modelsUnavailable("codex")),
            ),
    });
  }),
);

const TranslationHandlers = HttpApiBuilder.group(
  Api,
  "translation",
  Effect.fnUntraced(function* (handlers) {
    const runs = yield* Runs.Runs;
    return handlers.handleAll({
      status: Effect.fn("translation.status")(function* ({ query }) {
        const status = yield* runs
          .status(query.id)
          .pipe(Effect.catchTags({ GameNotInspectedError: notInspected }));
        return Option.getOrNull(status);
      }),
      start: Effect.fn("translation.start")(function* ({ payload }) {
        return yield* runs.start(payload.id, payload.kind).pipe(
          Effect.catchTags({
            GameNotInspectedError: notInspected,
            GameBusyError: () => Effect.fail(new GameBusy()),
            StateFileError: stateFileFailed,
          }),
        );
      }),
      stop: Effect.fn("translation.stop")(function* ({ payload }) {
        const status = yield* runs
          .stop(payload.id)
          .pipe(Effect.catchTags({ GameNotInspectedError: notInspected }));
        return Option.getOrNull(status);
      }),
    });
  }),
);

export const layer = Layer.mergeAll(OllamaHandlers, AgentsHandlers, TranslationHandlers);
