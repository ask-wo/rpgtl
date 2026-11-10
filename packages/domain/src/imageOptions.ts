import type { Catalog, LetteringFont } from "@rpgtl/contracts";

/**
 * A game's choices for its images, as the Images page edits them. An absent field stays as saved;
 * null or an empty list removes it.
 */
export interface ImageOptions {
  readonly imageBold?: "always" | "never" | null;
  readonly imageFont?: LetteringFont | null;
  readonly unchangedImages?: ReadonlyArray<string>;
}

/** The catalog with the user's image choices. */
export function withImageOptions(catalog: Catalog, options: ImageOptions): Catalog {
  const { imageBold: _bold, imageFont: _font, unchangedImages: _kept, ...rest } = catalog;
  const imageBold = options.imageBold === undefined ? catalog.imageBold : options.imageBold;
  const imageFont = options.imageFont === undefined ? catalog.imageFont : options.imageFont;
  const unchangedImages = options.unchangedImages
    ? [...new Set(options.unchangedImages)]
    : catalog.unchangedImages;
  return {
    ...rest,
    translate: catalog.translate,
    ...(imageBold && { imageBold }),
    ...(imageFont && { imageFont }),
    ...(unchangedImages && unchangedImages.length > 0 && { unchangedImages }),
  };
}
