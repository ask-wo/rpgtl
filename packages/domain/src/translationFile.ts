import {
  TranslationFile,
  TranslationFileProblem,
  translationFileProblem,
  type Catalog,
  type Entry,
  type ExportedImageText,
  type ImageReadResults,
  type ImportPreview,
  type Text,
} from "@rpgtl/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { textKey, textsById, withTextOf } from "./catalog.ts";
import { imageRunsWithCounts, readResults } from "./imageReading.ts";
import { keepsControlCodes } from "./controlCodes.ts";
import { renamedTranslation, repeatedSource, withoutStrayPronoun } from "./glossaryEdits.ts";
import { translationInUse } from "./inUse.ts";
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
const isOlder = Schema.is(
  Schema.Struct({
    version: Schema.Finite.check(Schema.isLessThan(TranslationFile.fields.version.literal)),
  }),
);

export const decodeTranslationFile = (input: unknown) =>
  Schema.decodeUnknownResult(TranslationFile)(input).pipe(
    Result.mapError((error) =>
      isNewer(input)
        ? new TranslationFileInvalid({ problem: "newer" })
        : isOlder(input)
          ? new TranslationFileInvalid({ problem: "older" })
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

const textFields = [
  "modelTranslation",
  "unshortenedTranslation",
  "flagReason",
  "rejectedTranslation",
  "rejectionReason",
  "userTranslation",
] as const;

const termFields = [
  "modelTranslation",
  "userTranslation",
  "modelKind",
  "userKind",
  "modelPronoun",
  "userPronoun",
] as const;

const rulesFields = ["rulesKind", "rulesPronoun", "sheClues", "heClues"] as const;

/**
 * The catalog and its exported image text as a translation file: every text, the image entries
 * with their text and the entries left untranslated, the glossary, the settings, and the runs that
 * made the model's values still in use, with how many each made.
 */
export function translationFile(
  catalog: Catalog,
  imageText: ExportedImageText | undefined,
): TranslationFile {
  const texts = textsById(catalog);
  const made = new Map<number, number>();
  for (const { modelOperationId: id } of [...catalog.texts, ...catalog.glossary])
    if (id !== undefined) made.set(id, (made.get(id) ?? 0) + 1);
  const operations = catalog.operations.flatMap(({ id, kind, startedAt, models }) => {
    const values = made.get(id);
    return values ? [{ kind, startedAt, ...(models && { models }), values }] : [];
  });
  const imageRuns = imageText ? imageRunsWithCounts(imageText) : {};
  const { sourceLanguage, letteringFont, letteringWeight, untranslatedImages } = catalog.settings;
  return {
    version: 2,
    texts: catalog.texts.map((text) =>
      Struct.pick(text, ["source", "speaker", "isInImage", ...textFields]),
    ),
    entries: catalog.entries.flatMap(({ id, textId, location, isLeftUntranslated }) => {
      const source = isImageText({ location }) ? texts.get(textId)?.source : undefined;
      return source !== undefined || isLeftUntranslated
        ? [
            {
              id,
              ...(source !== undefined && { source }),
              ...(isLeftUntranslated && { isLeftUntranslated }),
            },
          ]
        : [];
    }),
    glossary: catalog.glossary.map((term) =>
      Struct.pick(term, ["source", ...rulesFields, ...termFields]),
    ),
    settings: {
      ...(sourceLanguage && { sourceLanguage }),
      ...(letteringFont && { letteringFont }),
      ...(letteringWeight && { letteringWeight }),
      ...(untranslatedImages.length && { untranslatedImages }),
    },
    ...(operations.length && { operations }),
    ...(Object.keys(imageRuns).length && { imageRuns }),
    ...(imageText && { images: imageText.images }),
  };
}

/** The file's texts by key, failing on a repeated one or English that drops a control code. */
function fileTexts(file: TranslationFile) {
  const texts = new Map<string, TranslationFile["texts"][number]>();
  for (const text of file.texts) {
    const key = textKey(text);
    if (texts.has(key)) return invalid("duplicateText");
    const translation = translationInUse(text);
    if (translation && !keepsControlCodes(text.source, translation))
      return invalid("controlCodes", text.source.slice(0, 80));
    texts.set(key, text);
  }
  return Result.succeed(texts);
}

/**
 * The catalog with the file's translations, glossary and settings. A file's text replaces the
 * model's and the user's values of the game's text of the same source, speaker and image flag;
 * game texts the file doesn't have keep theirs, and file texts the game doesn't have, as lines
 * another version of the game dropped or changed, are left out. A term's kind and pronoun from
 * the rules stay the saved term's, if there is one. A renamed glossary term also renames the texts
 * that are exactly that term. Settings the file leaves out are removed.
 */
export function importTranslations(
  current: Catalog,
  file: TranslationFile,
): Result.Result<Catalog, TranslationFileInvalid> {
  if (repeatedSource(file.glossary) !== undefined) return invalid("duplicateTerm");
  const entries = new Map(current.entries.map((entry) => [entry.id, entry]));
  const named = new Map<string, TranslationFile["entries"][number]>();
  for (const entry of file.entries) {
    const original = entries.get(entry.id);
    if (!original) continue;
    if (named.has(entry.id)) return invalid("duplicateEntry");
    if (entry.isLeftUntranslated && !canKeepOriginal(original)) return invalid("leftUntranslated");
    named.set(entry.id, entry);
  }
  const found = fileTexts(file);
  if (Result.isFailure(found)) return Result.fail(found.failure);
  const byKey = found.success;
  // The same game has another id on another computer, so the file is matched by its text and by
  // entry ids, which come from the game's files.
  const keys = new Set(current.texts.map(textKey));
  if (byKey.size && !named.size && ![...byKey.keys()].some((key) => keys.has(key)))
    return invalid("otherGame");
  let catalog: Catalog = current;
  const moved = current.entries.map((entry): Entry => {
    const { isLeftUntranslated: _, ...rest } = entry;
    const update = named.get(entry.id);
    const left = update?.isLeftUntranslated && { isLeftUntranslated: true };
    if (update?.source === undefined || !isImageText(entry)) return { ...rest, ...left };
    const text = withTextOf(catalog, { source: update.source, isInImage: true });
    catalog = text.catalog;
    return { ...rest, textId: text.id, ...left };
  });
  const saved = new Map(current.glossary.map((term) => [term.source, term]));
  let added = Math.min(0, ...current.glossary.map((term) => term.id));
  const glossary = file.glossary.map((term) => {
    const own = saved.get(term.source);
    return withoutStrayPronoun({
      ...(own
        ? Struct.pick(own, ["id", ...rulesFields])
        : { id: (added -= 1), ...Struct.pick(term, rulesFields) }),
      source: term.source,
      ...Struct.pick(term, termFields),
    });
  });
  const rename = renamedTranslation(current.glossary, glossary);
  const texts = catalog.texts.map((text): Text => {
    const update = byKey.get(textKey(text));
    if (!update) return rename(text);
    const { id, source, speaker, isInImage } = text;
    return rename({
      id,
      source,
      isInImage,
      ...(speaker !== undefined && { speaker }),
      ...Struct.pick(update, textFields),
    });
  });
  const { sourceLanguage, letteringFont, letteringWeight, untranslatedImages = [] } = file.settings;
  const {
    sourceLanguage: _,
    letteringFont: __,
    letteringWeight: ___,
    ...settings
  } = current.settings;
  return Result.succeed({
    ...current,
    entries: moved,
    texts,
    glossary,
    settings: {
      ...settings,
      ...(sourceLanguage && { sourceLanguage }),
      ...(letteringFont && { letteringFont }),
      ...(letteringWeight && { letteringWeight }),
      untranslatedImages: [...new Set(untranslatedImages)],
    },
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
  const saved = new Map(before.texts.map((text) => [text.id, translationInUse(text)]));
  const keys = new Set(after.texts.map(textKey));
  const inFile = file.texts.filter((text) => translationInUse(text));
  const translations = {
    inFile: inFile.length,
    added: 0,
    changed: 0,
    cleared: 0,
    notInGame: inFile.filter((text) => !keys.has(textKey(text))).length,
  };
  const used = new Set(after.entries.map((entry) => entry.textId));
  for (const text of after.texts) {
    if (!used.has(text.id)) continue;
    const was = saved.get(text.id) ?? "";
    const translation = translationInUse(text);
    if (was === translation) continue;
    if (!was) translations.added++;
    else if (!translation) translations.cleared++;
    else translations.changed++;
  }
  const terms = new Map(before.glossary.map((term) => [term.source, translationInUse(term)]));
  const glossary = { inFile: after.glossary.length, added: 0, changed: 0, removed: 0 };
  for (const term of after.glossary) {
    const was = terms.get(term.source);
    if (was === undefined) glossary.added++;
    else if (was !== translationInUse(term)) glossary.changed++;
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
