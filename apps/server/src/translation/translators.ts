import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel";
import type {
  ClaudeSettings,
  CodexSettings,
  OllamaSettings,
  TranslationSettings,
} from "@rpgtl/contracts";
import { endpointProblem } from "@rpgtl/contracts";
import { localEndpoint, retrySampling, samplingOptions } from "@rpgtl/domain";
import * as AiError from "effect/ai/AiError";
import type * as LanguageModel from "effect/ai/LanguageModel";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as LlamaServer from "../localModels/LlamaServer.ts";
import * as AgentModels from "./AgentModels.ts";
import * as ClaudeLanguageModel from "./ClaudeLanguageModel.ts";
import * as CodexLanguageModel from "./CodexLanguageModel.ts";
import * as Ollama from "../localModels/Ollama.ts";
import * as OllamaLanguageModel from "./OllamaLanguageModel.ts";
import { RunReport } from "./RunReport.ts";
import type { Pass, Translator } from "./translate.ts";

/** An Ollama endpoint that isn't an HTTP server on this computer. */
export class EndpointRejectedError extends Schema.TaggedError<EndpointRejectedError>()(
  "EndpointRejectedError",
  { problem: Schema.Literals(["invalid", "notHttp", "notLocal"]) },
) {
  override get message() {
    return endpointProblem(this.problem);
  }
}

/** Batches for Claude and Codex, whose requests each start a CLI process. */
const agentBatches = {
  batchSize: 40,
  sceneSize: 150,
  contextLines: 10,
  packsScenes: true,
  capsAnswers: false,
  deterministic: true,
} as const;

/** Claude and Codex need no GPU, and each request mostly waits for its CLI to start. */
const agentParallel = 16;

const byLength = (response: LanguageModel.GenerateTextResponse<{}>) =>
  response.finishReason === "length";

const claude = Effect.fn("translators.claude")(function* (settings: ClaudeSettings) {
  const pass = Effect.fnUntraced(function* (model: string) {
    const built = yield* Layer.build(ClaudeLanguageModel.layer({ model }));
    return {
      model,
      parallel: agentParallel,
      provide: Effect.provideContext(built),
      configure: ({ kind }) =>
        ClaudeLanguageModel.withConfigOverride(
          kind === "text"
            ? // Dialogue batches share little beyond the system prompt, so caching them costs more.
              { cache: false, effort: settings.effort }
            : { cache: true, effort: settings.glossaryEffort },
        ),
      contextFull: byLength,
      loadedWarning: Effect.succeedNone,
    } satisfies Pass;
  });
  return {
    ...agentBatches,
    cachesPrompt: true,
    names: yield* pass(settings.glossaryModel),
    text: yield* pass(settings.model),
  } satisfies Translator;
});

const codexUnavailable = (error: { readonly message: string }) =>
  AiError.make({
    module: "CodexLanguageModel",
    method: "make",
    reason: new AiError.InternalProviderError({ description: error.message }),
  });

/** The model Codex picks for this login, which depends on its plan. */
const codexDefaultModel = Effect.gen(function* () {
  const agentModels = yield* AgentModels.AgentModels;
  const listed = yield* agentModels.codex.pipe(
    Effect.catchTags({
      CodexMissingError: codexUnavailable,
      AgentModelsError: codexUnavailable,
    }),
  );
  const found = listed.find((model) => model.isDefault) ?? listed[0];
  if (found) return found.id;
  return yield* AiError.make({
    module: "CodexLanguageModel",
    method: "make",
    reason: new AiError.InternalProviderError({ description: "Codex offers no models." }),
  });
});

const codex = Effect.fn("translators.codex")(function* (settings: CodexSettings) {
  const textModel = settings.model || (yield* codexDefaultModel);
  const glossaryModel = settings.glossaryModel || textModel;
  // Building the model checks Codex's login, so a run without one fails before it starts.
  const pass = Effect.fnUntraced(function* (model: string, effort: string) {
    const built = yield* Layer.build(CodexLanguageModel.layer({ model }));
    return {
      model,
      parallel: agentParallel,
      provide: Effect.provideContext(built),
      configure: () => CodexLanguageModel.withConfigOverride({ effort }),
      contextFull: byLength,
      loadedWarning: Effect.succeedNone,
    } satisfies Pass;
  });
  return {
    ...agentBatches,
    cachesPrompt: false,
    names: yield* pass(glossaryModel, settings.glossaryEffort),
    text: yield* pass(textModel, settings.effort),
  } satisfies Translator;
});

/** Only Ollama itself lets a local model think; llama-server always answers right away. */
const thinks = (settings: OllamaSettings) =>
  settings.effort === "on" && settings.expertLayersInRam === undefined;

/** A retry never uses temperature 0, which would give the same answer again. */
const localSampling = (
  settings: OllamaSettings,
  model: string,
  kind: string,
  retry: boolean,
): Readonly<Record<string, number>> => {
  if (kind === "question") return { temperature: 0 };
  const think = thinks(settings);
  if (!retry) return samplingOptions(settings.sampling, think);
  return retrySampling(model, settings.sampling) === "qwen" ? samplingOptions("qwen", think) : {};
};

/** Tokens of context a local model translates with; a batch that fills it is split and retried. */
export const numCtx = 4096;

const ollamaPass = Effect.fn("translators.ollamaPass")(function* (
  settings: OllamaSettings,
  endpoint: URL,
  model: string,
  /** Unloads the model when the pass ends, freeing its memory for the next. */
  unload: boolean,
) {
  const ollama = yield* Ollama.Ollama;
  const built = yield* Layer.build(OllamaLanguageModel.layer({ endpoint, model }));
  return {
    model,
    parallel: 1,
    provide: (self) => {
      const loaded = Effect.gen(function* () {
        const report = yield* RunReport;
        yield* report.step("Loading the model");
        yield* ollama.load(endpoint, model, numCtx);
        yield* report.step(undefined);
        return yield* Effect.provideContext(self, built);
      });
      return unload ? Effect.ensuring(loaded, ollama.unload(endpoint, model)) : loaded;
    },
    configure: ({ kind, answerTokens, retry = false }) =>
      OllamaLanguageModel.withConfigOverride({
        think: thinks(settings),
        options: {
          ...localSampling(settings, model, kind, retry),
          num_ctx: numCtx,
          // Ollama counts thinking against this cap, which is sized for the answer alone.
          ...(answerTokens !== undefined && !thinks(settings) && { num_predict: answerTokens }),
        },
      }),
    // Ollama cuts a prompt that doesn't fit and stops an answer that runs out of room, both
    // without an error.
    contextFull: (response) =>
      byLength(response) ||
      (response.usage.inputTokens.uncached ?? 0) + (response.usage.outputTokens.total ?? 0) >=
        numCtx - 16,
    loadedWarning: ollama
      .cpuShare(endpoint, model)
      .pipe(
        Effect.map(
          Option.flatMap((share) =>
            share > 0
              ? Option.some(
                  `Only ${Math.round((1 - share) * 100)}% of the model fits on the graphics card, and the CPU runs the rest more slowly. To fit more, close other programs that use the graphics card, then stop the run and start it again. On Linux, llama-server under Local models puts more of it on the card.`,
                )
              : Option.none(),
          ),
        ),
      ),
  } satisfies Pass;
});

/**
 * llama-server failing to start or ending during the run, as the run's failure: each of
 * LlamaServer's own errors says what to change, and a file or process failure has no wording.
 */
const llamaFailure = (error: LlamaServer.ServeError) =>
  AiError.make({
    module: "LlamaServer",
    method: "serve",
    reason: new AiError.InternalProviderError({
      description:
        error._tag === "PlatformError"
          ? "llama-server didn't start. RPGTL's log says why."
          : error.message,
    }),
  });

/** Where llama-server's output goes, and whether it reuses prompts (see `LlamaServer.serve`). */
interface LlamaOptions {
  readonly log: string;
  readonly promptCache?: boolean;
}

/** How many requests llama-server answers at once in a run. */
const llamaRequests = 4;

/** A model in llama-server, started when the pass begins and stopped when it ends. */
const llamaPass = Effect.fn("translators.llamaPass")(function* (
  settings: OllamaSettings & { readonly expertLayersInRam: number },
  endpoint: URL,
  options: LlamaOptions & { readonly unload: ReadonlyArray<string> },
) {
  const llamaServer = yield* LlamaServer.LlamaServer;
  const client = yield* HttpClient.HttpClient;
  // Started by the first pass that uses it, and stopped when the run ends.
  const started = yield* Effect.cached(
    Effect.gen(function* () {
      const report = yield* RunReport;
      yield* report.step("Loading the model");
      const server = yield* llamaServer
        .serve({
          endpoint,
          model: settings.model,
          unload: options.unload,
          expertLayersInRam: settings.expertLayersInRam,
          slots: llamaRequests,
          numCtx,
          log: options.log,
          ...(options.promptCache !== undefined && { promptCache: options.promptCache }),
        })
        .pipe(
          Effect.tapErrorTag("PlatformError", (error) =>
            Effect.logWarning("llama-server didn't start.", error),
          ),
          Effect.mapError(llamaFailure),
        );
      const built = yield* Layer.build(
        OpenAiLanguageModel.layer({ model: settings.model }).pipe(
          Layer.provide(OpenAiClient.layer({ apiUrl: server.api.href })),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        ),
      );
      yield* report.step(undefined);
      return { server, built };
    }).pipe(Scope.provide(yield* Effect.scope)),
  );
  return {
    model: settings.model,
    parallel: llamaRequests,
    provide: Effect.fn("translators.llamaProvide")(function* <A, E, R>(
      self: Effect.Effect<A, E, R>,
    ) {
      const { server, built } = yield* started;
      const exit = yield* Effect.exit(Effect.provideContext(self, built));
      if (Exit.isSuccess(exit) || Cause.hasInterrupts(exit.cause)) return yield* exit;
      // A request fails when the server ends under it; the server's end says why.
      const ended = yield* server.ended;
      if (Option.isNone(ended)) return yield* exit;
      return yield* llamaFailure(ended.value);
    }),
    configure: ({ kind, answerTokens, retry = false }) =>
      OpenAiLanguageModel.withConfigOverride({
        ...localSampling(settings, settings.model, kind, retry),
        ...(answerTokens !== undefined && { max_output_tokens: answerTokens }),
      }),
    contextFull: byLength,
    loadedWarning: Effect.succeedNone,
  } satisfies Pass;
});

const ollama = Effect.fn("translators.ollama")(function* (
  settings: OllamaSettings,
  llama: LlamaOptions,
) {
  const endpoint = yield* Effect.fromResult(
    Result.mapError(
      localEndpoint(settings.endpoint),
      (problem) => new EndpointRejectedError({ problem }),
    ),
  );
  const service = yield* Ollama.Ollama;
  const model = settings.model;
  const glossaryModel = settings.glossaryModel.trim() || model;
  // However the run ends, its models leave Ollama's memory then.
  yield* Effect.addFinalizer(() =>
    Effect.forEach(new Set([model, glossaryModel]), (name) => service.unload(endpoint, name), {
      discard: true,
    }),
  );
  const local = {
    batchSize: 10,
    sceneSize: 10,
    contextLines: 4,
    packsScenes: false,
    cachesPrompt: false,
    capsAnswers: true,
    // Retries sample with Qwen's settings.
    deterministic: false,
  } as const;
  const { expertLayersInRam } = settings;
  if (expertLayersInRam === undefined)
    return {
      ...local,
      names: yield* ollamaPass(settings, endpoint, glossaryModel, glossaryModel !== model),
      text: yield* ollamaPass(settings, endpoint, model, false),
    } satisfies Translator;
  const text = yield* llamaPass({ ...settings, expertLayersInRam }, endpoint, {
    ...llama,
    unload: [...new Set([model, glossaryModel])],
  });
  return {
    ...local,
    // A glossary model of its own runs in Ollama before llama-server starts; the same model shares
    // the server with the text pass.
    names:
      glossaryModel === model ? text : yield* ollamaPass(settings, endpoint, glossaryModel, true),
    text,
  } satisfies Translator;
});

/**
 * How a run with these settings asks its translator, with its models built in the scope, which
 * the run closes when it ends.
 */
export const translatorFor = Effect.fn("translatorFor")(function* (
  settings: TranslationSettings,
  llama: LlamaOptions,
) {
  return yield* Match.value(settings).pipe(
    Match.discriminatorsExhaustive("translator")({
      ollama: (ollamaSettings) => ollama(ollamaSettings, llama),
      claude,
      codex,
    }),
  );
});

/** What a translator needs to reach its model, apart from the run it reports to. */
export type TranslatorServices = Exclude<
  Effect.Services<ReturnType<typeof translatorFor>>,
  RunReport | Scope.Scope
>;
