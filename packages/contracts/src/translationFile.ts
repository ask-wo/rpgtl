import * as Schema from "effect/Schema";
import {
  GameSettings,
  OperationKind,
  PronounValue,
  SourceLanguage,
  GlossaryTerm,
  Text,
} from "./catalog.ts";
import { ExportedImage, ImageRun, imagePath, RecordWith } from "./imageText.ts";
import { RunModels } from "./runLog.ts";

const NonEmpty = Schema.Trim.check(Schema.isNonEmpty());
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const optional = Schema.optionalKey;

/**
 * A translation file, as export writes it and import reads it. Import takes the translations, the
 * glossary, the user's choices on entries and the settings in it; the entries' places and the
 * text read from the game come from the game.
 */
export const TranslationFile = Schema.Struct({
  version: Schema.Literal(2),
  /** Matched to the game's texts by source, speaker and image flag. */
  texts: Schema.Array(
    Schema.Struct({
      source: Schema.String,
      speaker: Text.fields.speaker,
      isInImage: Text.fields.isInImage,
      modelTranslation: optional(NonEmpty),
      unshortenedTranslation: Text.fields.unshortenedTranslation,
      flagReason: Text.fields.flagReason,
      rejectedTranslation: Text.fields.rejectedTranslation,
      rejectionReason: Text.fields.rejectionReason,
      userTranslation: optional(Schema.String),
    }),
  ),
  /** The entries the user changed: an image text they corrected, or one they left untranslated. */
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      /** The corrected text of an image entry. */
      source: optional(NonEmpty),
      isLeftUntranslated: optional(Schema.Boolean),
    }),
  ),
  glossary: Schema.Array(
    Schema.Struct({
      source: NonEmpty,
      modelTranslation: optional(NonEmpty),
      userTranslation: optional(NonEmpty),
      rulesKind: GlossaryTerm.fields.rulesKind,
      modelKind: GlossaryTerm.fields.modelKind,
      rulesPronoun: optional(PronounValue),
      sheClues: optional(Count),
      heClues: optional(Count),
      modelPronoun: optional(PronounValue),
      userKind: GlossaryTerm.fields.userKind,
      userPronoun: optional(PronounValue),
    }),
  ),
  settings: Schema.Struct({
    sourceLanguage: optional(SourceLanguage),
    letteringFont: GameSettings.fields.letteringFont,
    letteringWeight: GameSettings.fields.letteringWeight,
    untranslatedImages: optional(Schema.Array(Schema.String.check(Schema.isPattern(imagePath)))),
  }),
  /**
   * The runs that wrote the game's translations, with how many of the file's model translations
   * each wrote. Import ignores it.
   */
  operations: optional(
    Schema.Array(
      Schema.Struct({
        kind: OperationKind,
        startedAt: Schema.String,
        models: optional(RunModels),
        values: Count,
      }),
    ),
  ),
  /**
   * What each run an image's `run` names read and erased with. An export adds each run's `images`,
   * how many images it read last, which import ignores.
   */
  imageRuns: optional(
    Schema.Record(Schema.String, Schema.Struct({ ...ImageRun.fields, images: optional(Count) })),
  ),
  /** The read results and erased backgrounds of the game's images, when exported with them. */
  images: optional(RecordWith(imagePath, "an image path", ExportedImage)),
});
export type TranslationFile = typeof TranslationFile.Type;

/** What importing a translation file would change, counted before anything is saved. */
export const ImportPreview = Schema.Struct({
  /**
   * Texts the file gives English, how many of the game's texts would change, and how many of the
   * file's the game doesn't have, as in a file from another version of it.
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
  "older",
  "newer",
  "otherGame",
  "duplicateEntry",
  "duplicateText",
  "duplicateTerm",
  "controlCodes",
  "leftUntranslated",
  "images",
]);
export type TranslationFileProblem = typeof TranslationFileProblem.Type;

const problems: Record<TranslationFileProblem, (detail: string) => string> = {
  format: (detail) => `This translation file isn't in RPGTL's format: ${detail}`,
  older: () => "An older RPGTL made this translation file, in a format this one can't import.",
  newer: () => "A newer RPGTL made this translation file. Update RPGTL to import it.",
  otherGame: () => "This translation file belongs to a different game.",
  duplicateEntry: () => "Duplicate translation entry.",
  duplicateText: () => "Each text can be listed only once.",
  duplicateTerm: () => "Each glossary term can be listed only once.",
  controlCodes: (detail) => `Keep RPG Maker control codes intact: ${detail}`,
  leftUntranslated: () => "Keep original is only a setting for image text and script text.",
  images: () => "The image text in this translation file is damaged.",
};

/**
 * What the page shows for a translation file it can't import. `detail` is, for a format problem,
 * what doesn't match, and for control codes, the start of the source.
 */
export const translationFileProblem = (problem: TranslationFileProblem, detail = "") =>
  problems[problem](detail);
