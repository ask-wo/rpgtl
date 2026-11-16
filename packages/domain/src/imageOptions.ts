import type { Catalog, GameSettings, LetteringFont } from "@rpgtl/contracts";

/**
 * A game's choices for its images, as the Images page edits them. An absent field stays as saved;
 * null removes it.
 */
export interface ImageOptions {
  readonly letteringWeight?: NonNullable<GameSettings["letteringWeight"]> | null;
  readonly letteringFont?: LetteringFont | null;
  readonly untranslatedImages?: ReadonlyArray<string>;
}

/** The catalog with the user's image choices. */
export function withImageOptions(catalog: Catalog, options: ImageOptions): Catalog {
  const {
    letteringWeight: _weight,
    letteringFont: _font,
    untranslatedImages: _kept,
    ...rest
  } = catalog.settings;
  const letteringWeight =
    options.letteringWeight === undefined
      ? catalog.settings.letteringWeight
      : options.letteringWeight;
  const letteringFont =
    options.letteringFont === undefined ? catalog.settings.letteringFont : options.letteringFont;
  const untranslatedImages = options.untranslatedImages
    ? [...new Set(options.untranslatedImages)]
    : catalog.settings.untranslatedImages;
  return {
    ...catalog,
    settings: {
      ...rest,
      untranslatedImages,
      ...(letteringWeight && { letteringWeight }),
      ...(letteringFont && { letteringFont }),
    },
  };
}
