import {
  TranslationFile,
  TranslationFileProblem,
  translationFileProblem,
  type Catalog,
  type Entry,
  type GlossaryTerm,
  type ExportedImageText,
  type ImageReadResults,
  type ImportPreview,
} from "@rpgtl/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { cleared, guessRuns, runsWithCounts } from "./catalog.ts";
import { imageRunsWithCounts, readResults } from "./imageReading.ts";
import { idText } from "./imageText.ts";
import { keepsControlCodes } from "./controlCodes.ts";
import { englishByText } from "./inspect.ts";
import { renamedTranslation, repeatedSource, withoutStrayPronoun } from "./glossaryEdits.ts";
import { entryTranslation, importedValue, termTranslation, withoutGuess } from "./guesses.ts";
import { canKeepOriginal, isImageText } from "./location.ts";

/** A translation file that can't be imported into the catalog, and why. */
export class TranslationFileInvalid extends Schema.TaggedError<TranslationFileInvalid>()(
  "TranslationFileInvalid",
  {
    problem: TranslationFileProblem,
    /** For a format problem, what doesn't match; for control codes, the start of the source. */
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message() {
    return translationFileProblem(this.problem, this.detail);
  }
}

const invalid = (problem: TranslationFileProblem, detail?: string) =>
  Result.fail(new TranslationFileInvalid({ problem, ...(detail !== undefined && { detail }) }));

/** Reads a translation file, naming in the error what doesn't match the format. */
const isNewer = Schema.is(
  Schema.Struct({
    version: Schema.Finite.check(Schema.isGreaterThan(TranslationFile.fields.version.literal)),
  }),
);

export const decodeTranslationFile = (input: unknown) =>
  Schema.decodeUnknownResult(TranslationFile)(input).pipe(
    Result.mapError((error) =>
      isNewer(input)
        ? new TranslationFileInvalid({ problem: "newer" })
        : new TranslationFileInvalid({ problem: "format", detail: error.message }),
    ),
  );

/** Read results and the erased backgrounds they name, as the state folder keeps them. */
export interface ImageTextFiles {
  readonly results: ImageReadResults;
  readonly erased: ReadonlyMap<string, Uint8Array>;
}

/** The imported read results in place of the saved ones of the same images. */
export const importedImageText = (saved: ImageReadResults, imported: ImageTextFiles) =>
  ({
    results: readResults(
      { ...saved.images, ...imported.results.images },
      { ...saved.runs, ...imported.results.runs },
    ),
    erased: imported.erased,
  }) satisfies ImageTextFiles;

/**
 * The runs of the catalog and of its exported image text as a translation file names them, each
 * with how many entries or images are still its own.
 */
export const exportedRuns = (catalog: Catalog, imageText: ExportedImageText | undefined) => {
  const translationRuns = runsWithCounts(catalog);
  const imageRuns = imageText ? imageRunsWithCounts(imageText) : {};
  return {
    ...(Object.keys(translationRuns).length && { translationRuns }),
    ...(Object.keys(imageRuns).length && { imageRuns }),
  };
};

type FileEntry = TranslationFile["entries"][number];

/** File entries with English whose id or text the game doesn't have. */
const leftovers = (
  entries: ReadonlyArray<Pick<Entry, "id" | "source" | "readerText">>,
  file: TranslationFile,
) => {
  const sources = new Map(entries.map((entry) => [entry.id, idText(entry)]));
  return file.entries.filter(
    (entry) => entryTranslation(entry) && sources.get(entry.id) !== idText(entry),
  );
};

/** The game's text entries that no file entry names, each with a leftover of the same Chinese. */
function textMatches(
  entries: ReadonlyArray<Entry>,
  named: ReadonlySet<string>,
  leftover: ReadonlyArray<FileEntry>,
) {
  const bySource = englishByText(leftover);
  return entries.flatMap((entry) => {
    const match = bySource.get(entry.source);
    return match && !named.has(entry.id) && !isImageText(entry) ? [[entry, match] as const] : [];
  });
}

/** The entry with an image's text as the file has it, corrected or as read. */
function importedText<T extends Pick<Entry, "location" | "source" | "readerText">>(
  entry: T,
  update: FileEntry,
) {
  if (!isImageText(entry)) return entry;
  const { readerText: _, ...rest } = entry;
  return {
    ...rest,
    source: update.source,
    ...(update.readerText !== undefined && { readerText: update.readerText }),
  };
}

/** A glossary term as a translation file gives it, against the saved term of its source. */
const importedTerm = (
  saved: GlossaryTerm | undefined,
  term: TranslationFile["glossary"][number],
  known: (run: string) => boolean,
): GlossaryTerm => {
  const kind = importedValue(saved?.kind ?? { guess: term.kind.guess }, term.kind, known);
  return withoutStrayPronoun({
    source: term.source,
    translation: importedValue(saved?.translation ?? {}, term.translation, known),
    kind: {
      guess: kind.guess ?? term.kind.guess,
      ...(kind.user !== undefined && { user: kind.user }),
    },
    ...(term.pronoun && { pronoun: importedValue(saved?.pronoun ?? {}, term.pronoun, known) }),
  });
};

/**
 * The catalog with the file's translations, glossary and settings. A file entry matches the
 * game's entry of its id, or else the game's lines of the same Chinese that the file doesn't name;
 * the rest, as lines another version of the game dropped or changed, are left out. A renamed
 * glossary term also renames the entries that are exactly that term. Settings the file leaves out
 * are removed.
 */
export function importTranslations(
  current: Catalog,
  file: TranslationFile,
): Result.Result<Catalog, TranslationFileInvalid> {
  const known = new Map(current.entries.map((entry) => [entry.id, entry]));
  // The same game has another id on another computer; entry ids come from the game's file, place
  // and text alone.
  if (file.entries.length && !file.entries.some((entry) => known.has(entry.id)))
    return invalid("otherGame");
  if (repeatedSource(file.glossary) !== undefined) return invalid("duplicateTerm");
  const updates = new Map<string, FileEntry>();
  for (const entry of file.entries) {
    const original = known.get(entry.id);
    if (!original || idText(original) !== idText(entry)) continue;
    if (entry.readerText !== undefined && !isImageText(original)) continue;
    const translation = entryTranslation(entry);
    if (translation && !keepsControlCodes(entry.source, translation))
      return invalid("controlCodes", entry.source.slice(0, 80));
    if (entry.keepOriginal !== undefined && !canKeepOriginal(original))
      return invalid("keepOriginal");
    if (updates.has(entry.id)) return invalid("duplicateEntry");
    updates.set(entry.id, entry);
  }
  const named = new Set(updates.keys());
  for (const [entry, match] of textMatches(
    current.entries,
    named,
    leftovers(current.entries, file),
  )) {
    if (!keepsControlCodes(entry.source, entryTranslation(match)))
      return invalid("controlCodes", entry.source.slice(0, 80));
    updates.set(entry.id, { ...Struct.omit(match, ["keepOriginal"]), id: entry.id });
  }
  const runs = { ...current.runs, ...file.translationRuns };
  const knownRun = (run: string) => run in runs;
  const saved = new Map(current.glossary.map((term) => [term.source, term]));
  const glossary = file.glossary.map((term) =>
    importedTerm(saved.get(term.source), term, knownRun),
  );
  const rename = renamedTranslation(current.glossary, glossary);
  const entries = current.entries.map(({ suggestion, keepOriginal, ...entry }) => {
    const update = updates.get(entry.id);
    const text = update ? importedText(entry, update) : entry;
    const before =
      text.source === entry.source ? entry.translation : withoutGuess(entry.translation);
    const imported = rename(
      update ? { ...text, translation: importedValue(before, update.translation, knownRun) } : text,
    );
    const translation = entryTranslation(imported);
    const { previous, ...rest } = translation ? imported : cleared(text);
    return {
      ...rest,
      ...(previous !== undefined && previous !== translation && { previous }),
      ...((update ? !!update.keepOriginal : keepOriginal) && { keepOriginal: true }),
      ...(!translation && suggestion && { suggestion }),
    };
  });
  return Result.succeed({
    version: current.version,
    game: current.game,
    entries,
    glossary,
    translate: current.translate,
    ...(current.originalScripts && { originalScripts: true }),
    ...(current.disabledFixes?.length && { disabledFixes: current.disabledFixes }),
    ...(file.language && { language: file.language }),
    ...(file.imageBold && { imageBold: file.imageBold }),
    ...(file.imageFont && { imageFont: file.imageFont }),
    ...(file.unchangedImages?.length && { unchangedImages: [...new Set(file.unchangedImages)] }),
    ...(current.lastRun && { lastRun: current.lastRun }),
    ...guessRuns({ entries, glossary }, runs),
  });
}

/**
 * What importing `file` changes, from the catalog before it and the one `importTranslations` makes
 * of it, and the saved read results.
 */
export function importPreview(
  before: Catalog,
  after: Catalog,
  savedImages: ImageReadResults,
  file: TranslationFile,
): ImportPreview {
  const saved = new Map(before.entries.map((entry) => [entry.id, entryTranslation(entry)]));
  const leftover = leftovers(after.entries, file);
  const named = new Set(file.entries.map((entry) => entry.id));
  const matched = new Set(
    textMatches(after.entries, named, leftover).map(([, match]) => match.source),
  );
  const translations = {
    inFile: file.entries.filter((entry) => entryTranslation(entry)).length,
    added: 0,
    changed: 0,
    cleared: 0,
    notInGame: leftover.filter((entry) => !matched.has(entry.source)).length,
  };
  for (const entry of after.entries) {
    const was = saved.get(entry.id) ?? "";
    const translation = entryTranslation(entry);
    if (was === translation) continue;
    if (!was) translations.added++;
    else if (!translation) translations.cleared++;
    else translations.changed++;
  }
  const terms = new Map(before.glossary.map((term) => [term.source, termTranslation(term)]));
  const glossary = { inFile: after.glossary.length, added: 0, changed: 0, removed: 0 };
  for (const term of after.glossary) {
    const was = terms.get(term.source);
    if (was === undefined) glossary.added++;
    else if (was !== termTranslation(term)) glossary.changed++;
    terms.delete(term.source);
  }
  glossary.removed = terms.size;
  const images = Object.keys(file.images ?? {});
  return {
    translations,
    glossary,
    images: {
      inFile: images.length,
      replaced: images.filter((image) => image in savedImages.images).length,
    },
  };
}
