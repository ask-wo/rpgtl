import * as Schema from "effect/Schema";

/** How a local model samples: temperature 0, or Qwen's recommended settings. */
export const Sampling = Schema.Literals(["temperature-0", "qwen"]);
export type Sampling = typeof Sampling.Type;

/**
 * How a local model samples an answer asked again after it failed its checks: Qwen's recommended
 * settings, or the settings stored with the model, which Ollama uses when a request names none.
 */
export const RetrySampling = Schema.Literals(["qwen", "model"]);
export type RetrySampling = typeof RetrySampling.Type;

/**
 * How hard the model thinks. Claude and Codex take one of the model's levels, such as "low"; a
 * local model takes "off" or "on".
 */
export const Effort = Schema.String.annotate({ message: "Effort must be a string." });

/** A model the Claude or Codex CLI offers this login, as it lists them. */
export const AgentModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  efforts: Schema.Array(Schema.String),
  /** The level the CLI uses when none is set, where it says. */
  defaultEffort: Schema.optionalKey(Schema.String),
  /** The model the CLI uses when none is chosen. */
  isDefault: Schema.Boolean,
});
export type AgentModel = typeof AgentModel.Type;

const modelMissing = "Enter an Ollama model name.";
const layersInvalid = "Expert layers in system RAM must be a whole number.";

/** What a local Ollama model translates with, as the page keeps it for the next run. */
export const OllamaChoices = Schema.Struct({
  model: Schema.String.annotate({ message: modelMissing }).check(
    Schema.isPattern(/\S/, { message: modelMissing }),
  ),
  /** Translates the names and sorts the glossary; the dialogue model does when it is empty. */
  glossaryModel: Schema.String.annotate({ message: "Glossary model must be a string." }),
  sampling: Sampling.annotate({ message: "Choose Qwen's sampling settings or temperature 0." }),
  /** "on" lets the model think before it answers; only Ollama itself runs it so. */
  effort: Effort,
});
export type OllamaChoices = typeof OllamaChoices.Type;

const AgentModelId = Schema.String.annotate({ message: "A model must be a string." });

export const ClaudeChoices = Schema.Struct({
  model: AgentModelId,
  /** The glossary pass decides every later line, so the page offers Opus first. */
  glossaryModel: AgentModelId,
  /** How hard Claude thinks while translating dialogue. */
  effort: Effort,
  /** How hard the glossary model thinks. */
  glossaryEffort: Effort,
});
export type ClaudeChoices = typeof ClaudeChoices.Type;

export const CodexChoices = Schema.Struct({
  /** Empty for the model Codex picks for this login. */
  model: AgentModelId,
  /** Empty for the same as `model`. */
  glossaryModel: AgentModelId,
  effort: Effort,
  glossaryEffort: Effort,
});
export type CodexChoices = typeof CodexChoices.Type;

/** Each translator's choices until the user makes their own. */
export const defaultChoices: {
  readonly ollama: OllamaChoices;
  readonly claude: ClaudeChoices;
  readonly codex: CodexChoices;
} = {
  ollama: {
    model: "qwen3.6:35b-a3b-q4_K_M",
    glossaryModel: "",
    sampling: "temperature-0",
    effort: "off",
  },
  claude: {
    model: "claude-sonnet-5-5",
    glossaryModel: "claude-opus-5-5",
    effort: "medium",
    glossaryEffort: "low",
  },
  codex: { model: "", glossaryModel: "", effort: "medium", glossaryEffort: "medium" },
};

/** How many layers' experts stay in system RAM at least, which runs the model in llama-server. */
export const ExpertLayers = Schema.Number.annotate({ message: layersInvalid }).check(
  Schema.isInt({ message: layersInvalid }),
  Schema.isGreaterThanOrEqualTo(0, { message: layersInvalid }),
);

/** A run on a local Ollama server. */
export const OllamaSettings = Schema.Struct({
  translator: Schema.Literal("ollama"),
  endpoint: Schema.String,
  ...OllamaChoices.fields,
  /**
   * Runs the model in llama-server with the experts of at least this many layers in system RAM,
   * and more until the rest fits; Ollama places them without.
   */
  expertLayersInRam: Schema.optionalKey(ExpertLayers),
});
export type OllamaSettings = typeof OllamaSettings.Type;

export const ClaudeSettings = Schema.Struct({
  translator: Schema.Literal("claude"),
  ...ClaudeChoices.fields,
});
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const CodexSettings = Schema.Struct({
  translator: Schema.Literal("codex"),
  ...CodexChoices.fields,
});
export type CodexSettings = typeof CodexSettings.Type;

/** What a translation run uses, as the page sends it. */
export const TranslationSettings = Schema.Union([
  OllamaSettings,
  ClaudeSettings,
  CodexSettings,
]).annotate({ message: "Choose Ollama, Claude or Codex." });
export type TranslationSettings = typeof TranslationSettings.Type;

/** Which button started a run: Translate, or Build glossary, which stops after the glossary pass. */
export const RunKind = Schema.Literals(["translate", "build-glossary"]);
export type RunKind = typeof RunKind.Type;

/** A game a run waits for, by its id and its title, in English where the game has one. */
export const RunGame = Schema.Struct({ id: Schema.String, title: Schema.String });
export type RunGame = typeof RunGame.Type;

/** A run that goes, or waits ahead, and keeps another run from starting. */
export const WaitingFor = Schema.Struct({
  kind: Schema.Literals(["translation", "imageReading"]),
  game: RunGame,
});
export type WaitingFor = typeof WaitingFor.Type;

/** A translation run or image reading of any game that goes, or waits for `waitingFor`. */
export const QueuedRun = Schema.Struct({
  kind: WaitingFor.fields.kind,
  game: RunGame,
  /** Empty once its turn has come, until it has let its game go. */
  waitingFor: Schema.Array(WaitingFor),
});
export type QueuedRun = typeof QueuedRun.Type;

/**
 * Where a translation run or image reading is. `Waiting`: another run keeps it from starting
 * yet, and its game isn't held. `Ending`: its work is over, but the game stays held and its
 * models in memory until they are freed, which can take seconds.
 */
export const runPhase = <Running extends Schema.Struct.Fields>(running: Running) =>
  Schema.Union([
    Schema.TaggedStruct("Waiting", { for: Schema.NonEmptyArray(WaitingFor) }),
    Schema.TaggedStruct("Running", running),
    Schema.TaggedStruct("Ending", {}),
    Schema.TaggedStruct("Finished", {}),
    Schema.TaggedStruct("Stopped", {}),
    /** Ended early; `error` says why, for the page to show. */
    Schema.TaggedStruct("Failed", { error: Schema.String }),
  ]);

/** Whether a run in `phase` has ended and let its game go. */
export const runEnded = (phase: { readonly _tag: string }) =>
  phase._tag === "Finished" || phase._tag === "Stopped" || phase._tag === "Failed";

/** Whether a run in `phase` holds its game, so the game's translations can't change meanwhile. */
export const runHolds = (phase: { readonly _tag: string }) =>
  phase._tag === "Running" || phase._tag === "Ending";

/** A game's translation run, as the page shows it. */
export const RunStatus = Schema.Struct({
  kind: RunKind,
  phase: runPhase({
    /** What the run does between translating entries, such as sorting the glossary. */
    step: Schema.optionalKey(Schema.String),
  }),
  /** Entries the run set out to translate. */
  total: Schema.Int,
  /** Of those, the ones translated so far. */
  done: Schema.Int,
  /** Translated entries in the whole catalog, including ones from earlier runs. */
  translated: Schema.Int,
  /** Entries the run gave up on, by id. */
  failed: Schema.Array(Schema.String),
  left: Schema.Int,
  warnings: Schema.Array(Schema.String),
});
export type RunStatus = typeof RunStatus.Type;
