import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type { ImageReadingSettings } from "./imageText.ts";
import {
  ClaudeChoices,
  CodexChoices,
  defaultChoices,
  ExpertLayers,
  OllamaChoices,
  type TranslationSettings,
} from "./translation.ts";

/** `schema`, with `value` when the saved file has none. */
const orDefault = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  schema.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(value)));

/** A group of settings, each with its default when the saved file lacks the group or some of it. */
const group = <S extends Schema.Top>(schema: S) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed({})));

const { ollama, claude, codex } = defaultChoices;

/** The choices the page restores on load, kept in `$XDG_CONFIG_HOME/rpgtl/settings.json`. */
export const Settings = Schema.Struct({
  /** Enlarges games by whole multiples with even pixels and smooths only the rest. */
  sharpPixels: orDefault(Schema.Boolean, false),
  /** Renders games and their text at the screen's resolution. */
  sharpText: orDefault(Schema.Boolean, false),
  /** The local Ollama server and how it runs the models, which translation and images share. */
  ollama: group(
    Schema.Struct({
      endpoint: orDefault(Schema.String, "http://127.0.0.1:11434"),
      /** Runs the models in Ollama, or in Ollama's bundled llama-server. */
      runner: orDefault(Schema.Literals(["ollama", "llama-server"]), "ollama"),
      /**
       * In llama-server, how many layers' experts stay in system RAM at least; it keeps more until
       * the rest fits in VRAM. 0 is Automatic.
       */
      minExpertLayersInRam: orDefault(ExpertLayers, 0),
    }),
  ),
  translation: group(
    Schema.Struct({
      translator: orDefault(Schema.Literals(["ollama", "claude", "codex"]), "ollama"),
      ollama: group(
        OllamaChoices.mapFields(
          Struct.evolve({
            model: (schema) => orDefault(schema, ollama.model),
            glossaryModel: (schema) => orDefault(schema, ollama.glossaryModel),
            sampling: (schema) => orDefault(schema, ollama.sampling),
            effort: (schema) => orDefault(schema, ollama.effort),
          }),
        ),
      ),
      claude: group(
        ClaudeChoices.mapFields(
          Struct.evolve({
            model: (schema) => orDefault(schema, claude.model),
            glossaryModel: (schema) => orDefault(schema, claude.glossaryModel),
            effort: (schema) => orDefault(schema, claude.effort),
            glossaryEffort: (schema) => orDefault(schema, claude.glossaryEffort),
          }),
        ),
      ),
      codex: group(
        CodexChoices.mapFields(
          Struct.evolve({
            model: (schema) => orDefault(schema, codex.model),
            glossaryModel: (schema) => orDefault(schema, codex.glossaryModel),
            effort: (schema) => orDefault(schema, codex.effort),
            glossaryEffort: (schema) => orDefault(schema, codex.glossaryEffort),
          }),
        ),
      ),
    }),
  ),
  images: group(
    Schema.Struct({
      /** The backup reader: the Ollama model that helps read images; empty for none. */
      model: orDefault(Schema.String, ""),
      /** Keeps very faint lettering, which is skipped as watermarks otherwise. */
      includeFaint: orDefault(Schema.Boolean, false),
    }),
  ),
});
export type Settings = typeof Settings.Type;

/** What reading images uses with `settings`. */
export const imageReadingSettings = (settings: Settings): ImageReadingSettings => {
  const { model, includeFaint } = settings.images;
  return {
    ollamaEndpoint: settings.ollama.endpoint,
    includeFaint,
    ...(model && { fallbackModel: model }),
    ...llamaServerLayers(settings.ollama),
  };
};

/** The expert layers that run local models in llama-server, when the user chose it. */
const llamaServerLayers = (local: Settings["ollama"]) =>
  local.runner === "llama-server" ? { expertLayersInRam: local.minExpertLayersInRam } : {};

/** What a translation run uses with `settings`: the chosen translator with its own settings. */
export const translationSettings = ({
  ollama: local,
  translation,
}: Settings): TranslationSettings => {
  switch (translation.translator) {
    case "ollama":
      return {
        translator: "ollama",
        endpoint: local.endpoint,
        ...translation.ollama,
        ...llamaServerLayers(local),
      };
    case "claude":
      return { translator: "claude", ...translation.claude };
    case "codex":
      return { translator: "codex", ...translation.codex };
  }
};
