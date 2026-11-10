import type { Game, ImageResult } from "@rpgtl/contracts";
import * as Schema from "effect/Schema";

/** `load`'s promise, kept under `key` until it fails, so the next call tries again. */
const once = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
  let loaded = cache.get(key);
  if (!loaded) {
    loaded = load();
    cache.set(key, loaded);
    loaded.catch(() => cache.delete(key));
  }
  return loaded;
};

/** What the page reads from a game's `data/System.json`. */
const System = Schema.Struct({
  hasEncryptedImages: Schema.optionalKey(Schema.Boolean),
  encryptionKey: Schema.optionalKey(Schema.String),
  advanced: Schema.optionalKey(
    Schema.Struct({ mainFontFilename: Schema.optionalKey(Schema.String) }),
  ),
});
const decodeSystem = Schema.decodeUnknownPromise(System);

const systems = new Map<string, Promise<typeof System.Type>>();
/** The game's `data/System.json`, as it plays in the browser. */
const system = (game: Game) =>
  once(systems, game.id, () =>
    fetch(`/game/${game.id}/data/System.json`)
      .then((response) => response.json())
      .then(decodeSystem),
  );

const fonts = new Map<string, Promise<string>>();
/**
 * The CSS family of the game's main font, added to the page's fonts under a name of its own, so
 * the page draws the English as the game does; sans-serif when the game names none.
 */
export const gameFont = (game: Game) =>
  once(fonts, game.id, async () => {
    const root = `/game/${game.id}/`;
    const file =
      game.engine === "MZ"
        ? (await system(game)).advanced?.mainFontFilename
        : /url\(["']?([^"')]+)["']?\)/.exec(
            await fetch(`${root}fonts/gamefont.css`).then((r) => (r.ok ? r.text() : "")),
          )?.[1];
    if (!file) return "sans-serif";
    const family = `rpgtl-font-${game.id}`;
    document.fonts.add(await new FontFace(family, `url("${root}fonts/${encodeURI(file)}")`).load());
    return `${family}, sans-serif`;
  }).catch(() => "sans-serif");

/**
 * An address the page can show the game's image `file` (`img/…` without its extension) from. An
 * encrypted image is the PNG with a 16-byte header and its first 16 bytes XORed with the key.
 */
async function imageAddress(game: Game, file: string) {
  const { hasEncryptedImages, encryptionKey } = await system(game);
  const url = `/game/${game.id}/${file.split("/").map(encodeURIComponent).join("/")}`;
  if (!hasEncryptedImages || !encryptionKey) return `${url}.png`;
  const response = await fetch(url + (game.engine === "MV" ? ".rpgmvp" : ".png_"));
  if (!response.ok) throw new Error(`Could not load ${file}.`);
  const bytes = new Uint8Array((await response.arrayBuffer()).slice(16));
  for (const [i, byte] of bytes.subarray(0, 16).entries())
    bytes[i] = byte ^ parseInt(encryptionKey.slice(i * 2, i * 2 + 2), 16);
  return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}

const loadImage = (src: string, file: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${file}.`));
    image.src = src;
  });

export interface ImageAssets {
  readonly original: HTMLImageElement;
  /** The image with its text erased, to draw the English into. */
  readonly erased: HTMLImageElement | undefined;
}

const assets = new Map<string, Promise<ImageAssets>>();
/** The original image and its erased background, loaded once per image and background. */
export const imageAssets = (game: Game, image: string, result: ImageResult) =>
  once(assets, `${game.id} ${image} ${result.erased ?? ""}`, async () => {
    const [original, erased] = await Promise.all([
      imageAddress(game, image).then((src) => loadImage(src, image)),
      result.erased ? loadImage(`/erased/${game.id}/${result.erased}`, image) : undefined,
    ]);
    return { original, erased };
  });
