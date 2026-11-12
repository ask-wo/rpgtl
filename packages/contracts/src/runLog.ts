import * as Schema from "effect/Schema";
import { Location } from "./location.ts";
import { Effort, RetrySampling, RunKind, Sampling } from "./translation.ts";

/** Why a run turned down a model's answer for an entry. */
export const RejectReason = Schema.Literals([
  "no answer",
  "refused",
  "context full",
  "answer too long",
  "unchanged",
  "placeholder missing",
  "placeholder extra",
  "placeholder repeated",
  "source text left",
  "validation failed",
  "other entries included",
  "answers out of order",
]);
export type RejectReason = typeof RejectReason.Type;

const SourceAndTranslation = Schema.Struct({
  source: Schema.String,
  translation: Schema.String,
});

/** What a run knew about an entry when it checked the answer, besides the entry itself. */
export const AnswerContext = Schema.Struct({
  /** Glossary terms whose translations may keep Chinese, Japanese or Korean writing. */
  glossary: Schema.optionalKey(Schema.Array(SourceAndTranslation)),
  speaker: Schema.optionalKey(SourceAndTranslation),
  /** How many characters the text has room for in its image. */
  limit: Schema.optionalKey(Schema.Int),
});
export type AnswerContext = typeof AnswerContext.Type;

const modelFields = {
  // Any name, so the logs of models RPGTL no longer offers still read.
  model: Schema.String,
  /** The model of the glossary pass. */
  glossaryModel: Schema.String,
};
/** The dialogue model's effort; older logs have none. */
const effortField = { effort: Schema.optionalKey(Effort) };
/** The glossary model's effort; older logs have none. */
const glossaryEffortField = { glossaryEffort: Schema.optionalKey(Effort) };
const OllamaModels = Schema.Struct({
  translator: Schema.Literal("ollama"),
  ...modelFields,
  numCtx: Schema.Int,
  sampling: Sampling,
  /** The dialogue model's sampling of answers asked again after they failed their checks. */
  retrySampling: Schema.optionalKey(RetrySampling),
  ...effortField,
});
const ClaudeModels = Schema.Struct({
  translator: Schema.Literal("claude"),
  ...modelFields,
  ...effortField,
  ...glossaryEffortField,
});
const CodexModels = Schema.Struct({
  translator: Schema.Literal("codex"),
  ...modelFields,
  ...effortField,
  ...glossaryEffortField,
});

/** The translator, models and settings of a run that shape its answers. */
export const RunModels = Schema.Union([OllamaModels, ClaudeModels, CodexModels]);
export type RunModels = typeof RunModels.Type;

const runFields = {
  type: Schema.Literal("run"),
  /** The same ISO time as `run` on each entry the run translated. */
  started: Schema.String,
  /** RPGTL's git commit, with "-dirty" when files had uncommitted changes. */
  commit: Schema.optionalKey(Schema.String),
  kind: RunKind,
  /** How many entries the run set out to translate. */
  entries: Schema.Int,
};
/** The first line of a run's log: what the run used. */
export const RunStartLine = Schema.Union([
  Schema.Struct({
    ...runFields,
    ...OllamaModels.fields,
    /** Without, Ollama placed the experts. */
    expertLayersInRam: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({ ...runFields, ...ClaudeModels.fields }),
  Schema.Struct({ ...runFields, ...CodexModels.fields }),
]);
export type RunStartLine = typeof RunStartLine.Type;

/** A message of a request, as the log keeps it. */
const LoggedMessage = Schema.Struct({
  role: Schema.Literals(["system", "user", "assistant"]),
  content: Schema.String,
});

/** One translation request of a run and what became of each entry it asked about. */
export const RequestLine = Schema.Struct({
  type: Schema.Literal("request"),
  at: Schema.String,
  entryIds: Schema.Array(Schema.String),
  /**
   * Sources include temporary speaker-name entries that are absent from the catalog. Each
   * translation is the one the run accepted from this request, or empty; an image entry whose
   * answer was too long gets its translation in the request that asks for a shorter one.
   */
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      /** None for a speaker's name, which only the run asks about. */
      location: Schema.optionalKey(Location),
      source: Schema.String,
      translation: Schema.String,
    }),
  ),
  /** Checking context for each entry, in the same order as entryIds. */
  answerContexts: Schema.Array(AnswerContext),
  request: Schema.Struct({ model: Schema.String, messages: Schema.Array(LoggedMessage) }),
  /** The answer's text, when there was one. */
  content: Schema.optionalKey(Schema.String),
  /** Why the request got no answer. */
  error: Schema.optionalKey(Schema.String),
  ms: Schema.Finite,
  promptTokens: Schema.optionalKey(Schema.Finite),
  promptMs: Schema.optionalKey(Schema.Finite),
  outputTokens: Schema.optionalKey(Schema.Finite),
  outputMs: Schema.optionalKey(Schema.Finite),
  /** What a Claude request would cost at API prices. */
  costUsd: Schema.optionalKey(Schema.Finite),
  rejected: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      /** The entry's raw source. */
      source: Schema.String,
      /** The control code each placeholder stands for: codes[n - 1] is {n}. */
      codes: Schema.Array(Schema.String),
      reason: RejectReason,
    }),
  ),
});
export type RequestLine = typeof RequestLine.Type;

/** A question outside translation, such as a term's kind or a character's pronoun. */
export const AskLine = Schema.Struct({
  type: Schema.Literal("ask"),
  at: Schema.String,
  model: Schema.String,
  system: Schema.String,
  user: Schema.String,
  answer: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.String),
  ms: Schema.Finite,
});
export type AskLine = typeof AskLine.Type;

export const WarningLine = Schema.Struct({
  type: Schema.Literal("warning"),
  at: Schema.String,
  message: Schema.String,
});

/** The last line of a run's log, unless RPGTL stopped during the run. */
export const RunEndLine = Schema.Struct({
  type: Schema.Literal("end"),
  at: Schema.String,
  translated: Schema.Int,
  failed: Schema.Array(Schema.String),
  stopped: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});
export type RunEndLine = typeof RunEndLine.Type;

/** A line of a run's log, `games/<game id>/logs/translation-<start time>.log` in the state folder. */
export const RunLogLine = Schema.Union([
  RunStartLine,
  RequestLine,
  AskLine,
  WarningLine,
  RunEndLine,
]);
export type RunLogLine = typeof RunLogLine.Type;
