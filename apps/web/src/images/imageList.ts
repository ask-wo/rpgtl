import type { ImageReadResults, ImageResult, Location } from "@rpgtl/contracts";
import type { ShownImages } from "./InGameImage.tsx";
import { type EntryText, entryTexts, isImageText, translationInUse } from "@rpgtl/domain";

/** Which images the Images page lists. */
export type ImageFilter = "all" | "untranslated" | "kept";

/** An entry of text read in an image. */
export type ImageEntryText = EntryText & {
  readonly location: Extract<Location, { readonly _tag: "ImageLines" }>;
};

export interface ListedImage {
  readonly image: string;
  readonly result: ImageResult;
  readonly entries: ReadonlyArray<ImageEntryText>;
}

/** The read images that hold text entries, each with its entries. */
export const imagesWithText = (results: ImageReadResults, shown: ShownImages) => {
  const byImage = new Map<string, Array<ImageEntryText>>();
  for (const entry of entryTexts(shown)) {
    if (!isImageText(entry)) continue;
    const entries = byImage.get(entry.location.image) ?? [];
    entries.push(entry);
    byImage.set(entry.location.image, entries);
  }
  return Object.entries(results.images).flatMap(([image, result]): Array<ListedImage> => {
    const entries = byImage.get(image);
    return entries ? [{ image, result, entries }] : [];
  });
};

export const keptWhole = (image: string, shown: ShownImages) =>
  shown.settings.untranslatedImages.includes(image);

/** Whether the filter and the search, in lower case, let the image through. */
export const isListed = (
  { image, entries }: ListedImage,
  filter: ImageFilter,
  query: string,
  shown: ShownImages,
) => {
  if (
    query &&
    ![image, ...entries.flatMap((entry) => [entry.source, translationInUse(entry)])]
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
      return (
        !kept && entries.some((entry) => !translationInUse(entry) && !entry.isLeftUntranslated)
      );
    case "kept":
      return kept || entries.some((entry) => entry.isLeftUntranslated === true);
  }
};

/** One line on how far the image's English is, or that the game shows the original. */
export const imageState = ({ image, entries }: ListedImage, shown: ShownImages) => {
  if (keptWhole(image, shown)) return { text: "Original kept", done: true };
  const open = entries.filter((entry) => !entry.isLeftUntranslated);
  const done = open.filter((entry) => translationInUse(entry)).length;
  return open.length === 0
    ? { text: "Original kept", done: true }
    : { text: `${done} of ${open.length} translated`, done: done === open.length };
};
