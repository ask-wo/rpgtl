import * as Schema from "effect/Schema";
import { Location } from "./location.ts";
import { RunModels } from "./runLog.ts";

export const Engine = Schema.Literals(["MV", "MZ", "XP"]);

/** The language a game's text is written in. */
export const SourceLanguage = Schema.Literals(["chinese", "japanese", "korean"]);
export type SourceLanguage = typeof SourceLanguage.Type;
export type Engine = typeof Engine.Type;

/** What a run or RPGTL's rules gave for a value; without `run`, the rules did. */
const Guess = <Value extends Schema.Top, const Fields extends Schema.Struct.Fields>(
  value: Value,
  fields: Fields,
) =>
  Schema.Struct({
    value,
    /** When the run that gave it started, as an ISO time. */
    run: Schema.optionalKey(Schema.String),
    ...fields,
  });

/**
 * A value a run or RPGTL's rules gave, `guess`, and the user's own in its place, `user`, which
 * keeps the guess to go back to. Runs and rules write only `guess` and the user only `user`; a user
 * value equal to the guess isn't kept.
 */
export const Guessed = <Value extends Schema.Top, const Fields extends Schema.Struct.Fields>(
  value: Value,
  fields: Fields,
) =>
  Schema.Struct({
    guess: Schema.optionalKey(Guess(value, fields)),
    user: Schema.optionalKey(value),
  });

/** An entry's English; none means it isn't translated yet. */
export const EntryTranslation = Guessed(Schema.String, {
  /** Why the run's answer is worth a look. */
  flag: Schema.optionalKey(Schema.String),
  /** The run's first answer, when the guess is a shorter second one that fits its image. */
  long: Schema.optionalKey(Schema.String),
});
export type EntryTranslation = typeof EntryTranslation.Type;

export const Entry = Schema.Struct({
  id: Schema.String,
  location: Location,
  source: Schema.String,
  /**
   * What the image reader read, when the user corrected it to `source`. The entry's id comes from
   * what was read, so it stays while the image reads the same.
   */
  readerText: Schema.optionalKey(Schema.String),
  translation: EntryTranslation,
  /** Speaker identified by a named dialogue picture in the event list. */
  speaker: Schema.optionalKey(Schema.String),
  /**
   * Keeps the original: an image block's pixels, including any decorative lettering, or a script
   * string's text. A run doesn't translate the entry.
   */
  keepOriginal: Schema.optionalKey(Schema.Boolean),
  /** The last answer a run rejected for this entry, for the user to fix; dropped once translated. */
  suggestion: Schema.optionalKey(Schema.Struct({ text: Schema.String, reason: Schema.String })),
  /** The English the entry had before it was last cleared; dropped once it is that English again. */
  previous: Schema.optionalKey(Schema.String),
});
export type Entry = typeof Entry.Type;

/** Why an English or an image's text the user typed for an entry can't be saved. */
export const EntryProblem = Schema.Literals([
  "unknownEntry",
  "controlCodes",
  "emptyText",
  "notImageText",
]);
export type EntryProblem = typeof EntryProblem.Type;

const problems: Record<EntryProblem, string> = {
  unknownEntry:
    "This entry is no longer in the game's text. Open the game again to read its text anew.",
  controlCodes:
    "Keep the original's RPG Maker control codes, such as \\N[1] or \\V[3], in the English.",
  emptyText:
    "Type the text the image shows. To leave the artwork as it is, choose Keep original artwork.",
  notImageText:
    "Only text read in an image can be corrected; the game's own text comes from its files.",
};

export const entryProblem = (problem: EntryProblem) => problems[problem];

export const PronounValue = Schema.Literals(["she", "he", "unknown"]);
export type PronounValue = typeof PronounValue.Type;

/** A character's pronoun; a guess from the text has how many clues said she and he. */
export const Pronoun = Guessed(PronounValue, {
  she: Schema.optionalKey(Schema.Int),
  he: Schema.optionalKey(Schema.Int),
});
export type Pronoun = typeof Pronoun.Type;

/**
 * A character gets a pronoun and short forms of a dotted name; a character or a name keeps its
 * capitals in sentences; a word is lowercased there.
 */
export const TermKind = Schema.Literals(["character", "name", "word"]);
export type TermKind = typeof TermKind.Type;

export const GlossaryTerm = Schema.Struct({
  source: Schema.String,
  /** None while no run gave English and the user typed none. */
  translation: Guessed(Schema.String, {}),
  /** A guess without a run is RPGTL's rules', which a run's model checks. */
  kind: Schema.Struct({ guess: Guess(TermKind, {}), user: Schema.optionalKey(TermKind) }),
  /** Only characters have one; none means RPGTL has not checked the character yet. */
  pronoun: Schema.optionalKey(Pronoun),
});
export type GlossaryTerm = typeof GlossaryTerm.Type;

/**
 * A glossary term as the Glossary page saves it: the user's own values, each in place of the
 * term's guess; an absent one uses the guess.
 */
export const TermEdit = Schema.Struct({
  source: Schema.String,
  translation: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(TermKind),
  pronoun: Schema.optionalKey(PronounValue),
});
export type TermEdit = typeof TermEdit.Type;

export const LetteringFont = Schema.Literals(["serif", "sans"]);
export type LetteringFont = typeof LetteringFont.Type;

/** A game's catalog file, `games/<game id>/catalog.json` in the state folder, and the export and import format. */
export const Catalog = Schema.Struct({
  version: Schema.Literal(1),
  game: Schema.Struct({ id: Schema.String, title: Schema.String, engine: Engine }),
  entries: Schema.Array(Entry),
  glossary: Schema.Array(GlossaryTerm),
  /** The translation switch: whether the game plays with its translations. */
  translate: Schema.Boolean,
  /**
   * Whether an XP game plays with its scripts unchanged, without the English of their strings,
   * and runs leave those strings out; absent means it plays with their English.
   */
  originalScripts: Schema.optionalKey(Schema.Boolean),
  /** The language the user chose for the game's text; absent means the one its text looks like. */
  language: Schema.optionalKey(SourceLanguage),
  /** Whether the English in images is always or never bold; absent follows each original's weight. */
  imageBold: Schema.optionalKey(Schema.Literals(["always", "never"])),
  /** A bundled font for the English in images; absent uses the game's own font. */
  imageFont: Schema.optionalKey(LetteringFont),
  /** Images the game always shows unchanged, by a path like `img/pictures/Notice`. */
  unchangedImages: Schema.optionalKey(Schema.Array(Schema.String)),
  /** When the last run that translated entries started, as an ISO time. */
  lastRun: Schema.optionalKey(Schema.String),
  /** What each run a guess's `run` names used, by that start time. */
  runs: Schema.optionalKey(Schema.Record(Schema.String, RunModels)),
});
export type Catalog = typeof Catalog.Type;
