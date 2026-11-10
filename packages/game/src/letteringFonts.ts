// Latin fonts for the English in images, for games whose own font doesn't suit their image lettering.
// The bundle carries them as data URLs, so the game, the NW.js hook and the RPGTL page need no font files.
import sans400 from "@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff2";
import sans700 from "@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff2";
import serif400 from "@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff2";
import serif700 from "@fontsource/noto-serif/files/noto-serif-latin-700-normal.woff2";
import type { LetteringFont } from "@rpgtl/contracts";

const files: Record<LetteringFont, [string, string]> = {
  sans: [sans400, sans700],
  serif: [serif400, serif700],
};
const added = new Set<LetteringFont>();

/** The CSS family of a bundled lettering font, added to the document's fonts on first use. */
export function letteringFace(font: LetteringFont) {
  const family = `rpgtl-lettering-${font}`;
  if (!added.has(font) && typeof FontFace === "function" && document.fonts) {
    added.add(font);
    files[font].forEach((url, index) =>
      document.fonts.add(new FontFace(family, `url(${url})`, { weight: index ? "700" : "400" })),
    );
  }
  return `${family}, sans-serif`;
}
