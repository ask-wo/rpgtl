import type { AgentModel, Sampling, Settings } from "@rpgtl/contracts";

export type Choice<V> = {
  readonly value: V;
  readonly label: string;
  /** Shown but not choosable. */
  readonly disabled?: boolean;
};

export type Translator = Settings["translation"]["translator"];

export const translators: ReadonlyArray<Choice<Translator>> = [
  { value: "ollama", label: "Ollama" },
  { value: "claude", label: "Claude (your subscription)" },
  { value: "codex", label: "Codex (your ChatGPT plan)" },
];

export const privacy: Record<Translator, string> = {
  ollama: "Text stays on this computer.",
  claude: "Sends the game's text to Anthropic. Uses your Claude subscription's limits.",
  codex: "Sends the game's text to OpenAI. Uses your ChatGPT plan's Codex limits.",
};

export const claudeRecommended = { model: "claude-sonnet-5-5", glossaryModel: "claude-opus-5-5" };
/** The effort levels past runs used, per model. */
export const claudeEfforts: Readonly<Record<string, string>> = { "claude-sonnet-5-5": "medium" };
export const claudeGlossaryEfforts: Readonly<Record<string, string>> = {
  "claude-opus-5-5": "low",
};

/** The models a CLI lists, with `chosen` kept even when the CLI no longer offers it. */
export const agentModelChoices = (
  listed: ReadonlyArray<AgentModel>,
  chosen: string,
  recommended?: string,
): Array<Choice<string>> => [
  ...(chosen && !listed.some((model) => model.id === chosen)
    ? [{ value: chosen, label: `${chosen} (not offered)` }]
    : []),
  ...listed.map(({ id, name }) => ({
    value: id,
    label: id === recommended ? `${name} (recommended)` : name,
  })),
];

const effortNames: Readonly<Record<string, string>> = { xhigh: "Extra high" };
const effortName = (level: string) =>
  effortNames[level] ?? level.charAt(0).toUpperCase() + level.slice(1);

/**
 * The effort levels `model` offers, with `chosen` kept even when it doesn't, `recommended` marked,
 * and the level the CLI uses when none is set named.
 */
export const effortChoices = (
  model: AgentModel | undefined,
  chosen: string,
  recommended?: string,
): Array<Choice<string>> => {
  const levels = model?.efforts ?? [];
  return [
    ...(levels.includes(chosen) ? [] : [{ value: chosen, label: effortName(chosen) }]),
    ...levels.map((level) => {
      const note =
        level === recommended
          ? "recommended"
          : level === model?.defaultEffort
            ? "default"
            : undefined;
      return { value: level, label: note ? `${effortName(level)} (${note})` : effortName(level) };
    }),
  ];
};

export const ollamaEfforts: ReadonlyArray<Choice<string>> = [
  { value: "off", label: "Off (recommended)" },
  { value: "on", label: "On" },
];

export const runners: ReadonlyArray<Choice<Settings["ollama"]["runner"]>> = [
  { value: "ollama", label: "Ollama" },
  { value: "llama-server", label: "llama-server" },
];

export const samplings: ReadonlyArray<Choice<Sampling>> = [
  { value: "temperature-0", label: "Temperature 0 (recommended)" },
  { value: "qwen", label: "Qwen's settings (Qwen3.6)" },
];

export const faintChoices: ReadonlyArray<Choice<"skip" | "include">> = [
  { value: "skip", label: "Skip very faint text" },
  { value: "include", label: "Include very faint text" },
];

/** Measured on a 172-entry sample of a Chinese game; Ollama took 124 s. */
export const qwenExpertHints: Record<number, string> = {
  35: "least VRAM, most RAM",
  33: "86 s on the sample",
  31: "80 s on the sample, nearly fills 8 GB of VRAM",
};

/** Whether a local model translates or reads images, which the local models' settings are for. */
export const usesLocalModels = (settings: Settings) =>
  settings.translation.translator === "ollama" || settings.images.model !== "";
