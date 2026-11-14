import * as Schema from "effect/Schema";
import {
  Entry,
  GlossaryTerm,
  Guessed,
  LetteringFont,
  PronounValue,
  SourceLanguage,
} from "./catalog.ts";
import { ExportedImage, ImageRun, imagePath, RecordWith } from "./imageText.ts";
import { RunModels } from "./runLog.ts";

const Text = Schema.Trim.check(Schema.isNonEmpty());
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const ImportedTerm = Schema.Struct({
  source: Text,
  translation: Guessed(Text, {}),
  kind: GlossaryTerm.fields.kind,
  pronoun: Schema.optionalKey(
    Guessed(PronounValue, { she: Schema.optionalKey(Count), he: Schema.optionalKey(Count) }),
  ),
});

/**
 * A translation file as import reads it: an exported catalog, or the page's edited one. Import keeps
 * only the translations, the runs that made them, the image texts the user corrected and settings
 * in it; the entries' places and the text read from the game come from the game.
 */
export const TranslationFile = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      source: Schema.String,
      readerText: Entry.fields.readerText,
      translation: Entry.fields.translation,
      keepOriginal: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  glossary: Schema.Array(ImportedTerm),
  language: Schema.optionalKey(SourceLanguage),
  imageBold: Schema.optionalKey(Schema.Literals(["always", "never"])),
  imageFont: Schema.optionalKey(LetteringFont),
  unchangedImages: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isPattern(imagePath))),
  ),
  /**
   * What each run a guess's `run` names used, by that start time. An export adds each run's
   * `guesses`, how many of its guesses are still in use, which import ignores.
   */
  translationRuns: Schema.optionalKey(Schema.Record(Schema.String, RunModels)),
  /**
   * What each run an image's `run` names read and erased with. An export adds each run's `images`,
   * how many images it read last, which import ignores.
   */
  imageRuns: Schema.optionalKey(Schema.Record(Schema.String, ImageRun)),
  /** The read results and erased backgrounds of the game's images, when exported with them. */
  images: Schema.optionalKey(RecordWith(imagePath, "an image path", ExportedImage)),
});
export type TranslationFile = typeof TranslationFile.Type;

/** What importing a translation file would change, counted before anything is saved. */
export const ImportPreview = Schema.Struct({
  /**
   * Entries the file gives English, how many of the game's entries would change, and how many of
   * the file's the game doesn't have, as in a file from another version of it.
   */
  translations: Schema.Struct({
    inFile: Count,
    added: Count,
    changed: Count,
    cleared: Count,
    notInGame: Count,
  }),
  /** The file's glossary replaces the saved one: terms by their Chinese. */
  glossary: Schema.Struct({
    inFile: Count,
    added: Count,
    changed: Count,
    removed: Count,
  }),
  /** Images whose image text the file carries, and how many of them already have read results. */
  images: Schema.Struct({ inFile: Count, replaced: Count }),
});
export type ImportPreview = typeof ImportPreview.Type;

/** How far an import has put the file's images together again, which is the slow part. */
export const ImportProgress = Schema.Struct({ done: Count, total: Count });
export type ImportProgress = typeof ImportProgress.Type;

/** Why a translation file can't be imported into a game's catalog. */
export const TranslationFileProblem = Schema.Literals([
  "format",
  "newer",
  "otherGame",
  "duplicateEntry",
  "duplicateTerm",
  "controlCodes",
  "keepOriginal",
  "images",
]);
export type TranslationFileProblem = typeof TranslationFileProblem.Type;

const problems: Record<TranslationFileProblem, (detail: string) => string> = {
  format: (detail) => `This translation file isn't in RPGTL's format: ${detail}`,
  newer: () => "A newer RPGTL made this translation file. Update RPGTL to import it.",
  otherGame: () => "This translation file belongs to a different game.",
  duplicateEntry: () => "Duplicate translation entry.",
  duplicateTerm: () => "Each glossary term can be listed only once.",
  controlCodes: (detail) => `Keep RPG Maker control codes intact: ${detail}`,
  keepOriginal: () => "Keep original is only a setting for image text and script text.",
  images: () => "The image text in this translation file is damaged.",
};

/**
 * What the page shows for a translation file it can't import. `detail` is, for a format problem,
 * what doesn't match, and for control codes, the start of the source.
 */
export const translationFileProblem = (problem: TranslationFileProblem, detail = "") =>
  problems[problem](detail);
