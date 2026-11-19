import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Location } from "./location.ts";
import { RunModels } from "./runLog.ts";

export const Engine = Schema.Literals(["MV", "MZ", "XP"]);

/** The language a game's text is written in. */
export const SourceLanguage = Schema.Literals(["chinese", "japanese", "korean"]);
export type SourceLanguage = typeof SourceLanguage.Type;
export type Engine = typeof Engine.Type;

/** An entry: one place in the game's files where a text appears. */
export const Entry = Schema.Struct({
  id: Schema.String,
  /** The text the entry shows: its source, speaker and translations. */
  textId: Schema.Int,
  location: Location,
  /**
   * The game's own English for a script string, which its English mode shows instead. Applying
   * puts the translation there too, and its length bounds the room the translation has.
   */
  builtinTranslation: Schema.optionalKey(Schema.String),
  /**
   * The line of a game's script that a script string is in, after the earlier lines of its method
   * that build the same variable, which shows a run what the game draws around the string.
   */
  code: Schema.optionalKey(Schema.String),
  /**
   * The user keeps the original here: an image block's pixels, including any decorative
   * lettering, or a script string's text. Runs leave the entry out.
   */
  isLeftUntranslated: Schema.optionalKey(Schema.Boolean),
});
export type Entry = typeof Entry.Type;

/**
 * One text, shared by every entry with the same source, speaker and image flag, so a fix reaches
 * every place it appears. Its translation in use is the user's, else a run's model's.
 */
export const Text = Schema.Struct({
  id: Schema.Int,
  source: Schema.String,
  /** Speaker identified by a named dialogue picture in the event list. */
  speaker: Schema.optionalKey(Schema.String),
  /** Text read in an image, which is translated apart from the same words in the game's data. */
  isInImage: Schema.Boolean,
  modelTranslation: Schema.optionalKey(Schema.String),
  /** The run that wrote the model's translation. */
  modelOperationId: Schema.optionalKey(Schema.Int),
  /** The model's first answer, when its translation is a shorter second one that fits where the game draws it. */
  unshortenedTranslation: Schema.optionalKey(Schema.String),
  /** Why the model's answer is worth a look. */
  flagReason: Schema.optionalKey(Schema.String),
  /** The last answer a run rejected, for the user to fix; dropped once translated. */
  rejectedTranslation: Schema.optionalKey(Schema.String),
  rejectionReason: Schema.optionalKey(Schema.String),
  userTranslation: Schema.optionalKey(Schema.String),
  /** The translation in use before it was last cleared, while another one or none is in use. */
  previousTranslation: Schema.optionalKey(Schema.String),
});
export type Text = typeof Text.Type;

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

/**
 * A character gets a pronoun and short forms of a dotted name; a character or a name keeps its
 * capitals in sentences; a word is lowercased there.
 */
export const TermKind = Schema.Literals(["character", "name", "word"]);
export type TermKind = typeof TermKind.Type;

/**
 * A translation glossary term. Its translation in use is the user's, else a run's model's; its
 * kind and pronoun in use are the user's, else the model's, else RPGTL's rules'.
 */
export const GlossaryTerm = Schema.Struct({
  id: Schema.Int,
  source: Schema.String,
  modelTranslation: Schema.optionalKey(Schema.String),
  /** The run that wrote the model's translation. */
  modelOperationId: Schema.optionalKey(Schema.Int),
  userTranslation: Schema.optionalKey(Schema.String),
  /** The English in use before it was last cleared, while another one or none is in use. */
  previousTranslation: Schema.optionalKey(Schema.String),
  /** RPGTL's rules give every term a kind, which a run's model checks. */
  rulesKind: TermKind,
  modelKind: Schema.optionalKey(TermKind),
  userKind: Schema.optionalKey(TermKind),
  /** Only characters have one; none means RPGTL has not checked the character yet. */
  rulesPronoun: Schema.optionalKey(PronounValue),
  /** How many clues in the game's text said she and he when the rules last looked. */
  sheClues: Schema.optionalKey(Schema.Int),
  heClues: Schema.optionalKey(Schema.Int),
  modelPronoun: Schema.optionalKey(PronounValue),
  userPronoun: Schema.optionalKey(PronounValue),
  /** What the user tells the model about the term, such as its plural, sent with the term. */
  userNote: Schema.optionalKey(Schema.String),
});
export type GlossaryTerm = typeof GlossaryTerm.Type;

/**
 * A glossary term as the Glossary page saves it: the user's own values; an absent one leaves the
 * term's others in use.
 */
export const TermEdit = Schema.Struct({
  source: Schema.String,
  userTranslation: Schema.optionalKey(Schema.String),
  userKind: Schema.optionalKey(TermKind),
  userPronoun: Schema.optionalKey(PronounValue),
  userNote: Schema.optionalKey(Schema.String),
});
export type TermEdit = typeof TermEdit.Type;

export const LetteringFont = Schema.Literals(["serif", "sans"]);
export type LetteringFont = typeof LetteringFont.Type;

/** What wrote to a game's text, glossary or images. */
export const OperationKind = Schema.Literals([
  "upgrade",
  "inspection",
  "run",
  "image_reading",
  "import",
  "edit",
  "clear",
  "undo",
]);
export type OperationKind = typeof OperationKind.Type;

export const Operation = Schema.Struct({
  id: Schema.Int,
  kind: OperationKind,
  /** ISO time. */
  startedAt: Schema.String,
  /** The models a run used. */
  models: Schema.optionalKey(RunModels),
});
export type Operation = typeof Operation.Type;

/** `schema`, with `value` when no value is saved. */
const orDefault = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  schema.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(value)));

/** A game's own settings; one not saved has its default. */
export const GameSettings = Schema.Struct({
  /** The translation switch: whether the game plays with its translations. */
  isTranslationOn: orDefault(Schema.Boolean, false),
  /**
   * Whether an XP game plays with the English of its scripts' strings and runs translate them;
   * off, the scripts stay as they are.
   */
  isScriptTranslationOn: orDefault(Schema.Boolean, true),
  /** The file names of the XP game's fixes that are off; a fix not listed is on. */
  disabledFixes: orDefault(Schema.Array(Schema.String), []),
  /** The language the user chose for the game's text; none means the one its text looks like. */
  sourceLanguage: Schema.optionalKey(SourceLanguage),
  /** A bundled font for the English in images; none uses the game's own font. */
  letteringFont: Schema.optionalKey(LetteringFont),
  /** The weight of the English in images; none follows each original's weight. */
  letteringWeight: Schema.optionalKey(Schema.Literals(["bold", "regular"])),
  /**
   * Images the game always shows as they are, by a path like `img/pictures/Notice`, or
   * `Graphics/Pictures/Notice` in an XP game.
   */
  untranslatedImages: orDefault(Schema.Array(Schema.String), []),
});
export type GameSettings = typeof GameSettings.Type;

/** A game's text, glossary and settings, and what wrote them, as its database holds them. */
export const Catalog = Schema.Struct({
  game: Schema.Struct({ id: Schema.String, title: Schema.String, engine: Engine }),
  entries: Schema.Array(Entry),
  texts: Schema.Array(Text),
  glossary: Schema.Array(GlossaryTerm),
  settings: GameSettings,
  operations: Schema.Array(Operation),
});
export type Catalog = typeof Catalog.Type;
