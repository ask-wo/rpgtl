import type { Catalog } from "@rpgtl/contracts";
import { entryTranslation, isImageText, isNameEntry, runTranslates } from "@rpgtl/domain";

export const number = (count: number) => count.toLocaleString("en");

export const megabytes = (bytes: number) => Math.round(bytes / 1e6).toLocaleString();

export const gigabytes = (bytes: number) => (bytes / 1e9).toFixed(1);

/** `count` with the word that fits it, as "1 entry" or "3 entries". */
export const counted = (count: number, one: string, many: string) =>
  `${number(count)} ${count === 1 ? one : many}`;

/**
 * What the catalog holds, counting the text of the game's data and of its images apart; text a
 * run leaves out isn't counted.
 */
export const catalogCounts = (catalog: Catalog) => {
  const { entries, glossary } = catalog;
  const translates = runTranslates(catalog);
  const text = entries.filter((entry) => !isImageText(entry) && translates(entry));
  const images = entries.filter(isImageText);
  const names = text.filter(isNameEntry);
  const translated = (list: typeof entries) =>
    list.filter((entry) => entryTranslation(entry)).length;
  return {
    text: { all: text.length, translated: translated(text) },
    /** The text's names, which the glossary pass translates. */
    names: { all: names.length, translated: translated(names) },
    images: {
      files: new Set(images.map((entry) => entry.location.image)).size,
      all: images.length,
      translated: translated(images),
      /** Entries without English that the game draws, so a run translates them. */
      untranslated: images.filter((entry) => !entryTranslation(entry) && translates(entry)).length,
    },
    glossary: glossary.length,
  };
};
