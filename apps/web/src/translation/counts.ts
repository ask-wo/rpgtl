import type { Catalog } from "@rpgtl/contracts";
import { areaOf } from "../text/search.ts";
import { entryTranslation } from "@rpgtl/domain";

export const number = (count: number) => count.toLocaleString("en");

export const megabytes = (bytes: number) => Math.round(bytes / 1e6).toLocaleString();

export const gigabytes = (bytes: number) => (bytes / 1e9).toFixed(1);

/** `count` with the word that fits it, as "1 entry" or "3 entries". */
export const counted = (count: number, one: string, many: string) =>
  `${number(count)} ${count === 1 ? one : many}`;

/** What the catalog holds, counting the text of the game's data and of its images apart. */
export const catalogCounts = ({ entries, glossary, unchangedImages = [] }: Catalog) => {
  const text = entries.filter((entry) => areaOf(entry.file) !== undefined);
  const images = entries.filter((entry) => areaOf(entry.file) === undefined);
  const translated = (list: typeof entries) =>
    list.filter((entry) => entryTranslation(entry)).length;
  return {
    text: { all: text.length, translated: translated(text) },
    images: {
      files: new Set(images.map((entry) => entry.file)).size,
      all: images.length,
      translated: translated(images),
      /** Entries without English that the game draws, so a run translates them. */
      untranslated: images.filter(
        (entry) =>
          !entryTranslation(entry) && !entry.keepOriginal && !unchangedImages.includes(entry.file),
      ).length,
    },
    glossary: glossary.length,
  };
};
