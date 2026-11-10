import type { Entry, ImageReadResults, ImageResult } from "@rpgtl/contracts";
import type { ShownImages } from "./InGameImage.tsx";
import { entryTranslation } from "@rpgtl/domain";

/** Which images the Images page lists. */
export type ImageFilter = "all" | "untranslated" | "kept";

export interface ListedImage {
  readonly image: string;
  readonly result: ImageResult;
  readonly entries: ReadonlyArray<Entry>;
}

/** The read images that hold text entries, each with its entries. */
export const imagesWithText = (results: ImageReadResults, shown: ShownImages) => {
  const byImage = new Map<string, Array<Entry>>();
  for (const entry of shown.entries) {
    if (!entry.file.startsWith("img/")) continue;
    const entries = byImage.get(entry.file) ?? [];
    entries.push(entry);
    byImage.set(entry.file, entries);
  }
  return Object.entries(results.images).flatMap(([image, result]): Array<ListedImage> => {
    const entries = byImage.get(image);
    return entries ? [{ image, result, entries }] : [];
  });
};

export const keptWhole = (image: string, shown: ShownImages) =>
  shown.unchangedImages?.includes(image) === true;

/** Whether the filter and the search, in lower case, let the image through. */
export const isListed = (
  { image, entries }: ListedImage,
  filter: ImageFilter,
  query: string,
  shown: ShownImages,
) => {
  if (
    query &&
    ![image, ...entries.flatMap((entry) => [entry.source, entryTranslation(entry)])]
      .join(" ")
      .toLowerCase()
      .includes(query)
  )
    return false;
  const kept = keptWhole(image, shown);
  switch (filter) {
    case "all":
      return true;
    case "untranslated":
      return !kept && entries.some((entry) => !entryTranslation(entry) && !entry.keepOriginal);
    case "kept":
      return kept || entries.some((entry) => entry.keepOriginal === true);
  }
};

/** One line on how far the image's English is, or that the game shows the original. */
export const imageState = ({ image, entries }: ListedImage, shown: ShownImages) => {
  if (keptWhole(image, shown)) return { text: "Original kept", done: true };
  const open = entries.filter((entry) => !entry.keepOriginal);
  const done = open.filter((entry) => entryTranslation(entry)).length;
  return open.length === 0
    ? { text: "Original kept", done: true }
    : { text: `${done} of ${open.length} translated`, done: done === open.length };
};
