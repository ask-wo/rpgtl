import { type Game, gameFiles, type ImageTextHint } from "@rpgtl/contracts";
import {
  erasedPatches,
  imageFontOf,
  imageHash,
  imageTextHints,
  type Pixels,
  xpImageFolder,
  type XpLetteredImage,
} from "@rpgtl/domain";
import { drawImageText } from "@rpgtl/game/lettering";
import { type Canvas, createCanvas, GlobalFonts, type Image, loadImage } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PNG } from "pngjs";
import * as Catalogs from "../games/Catalogs.ts";
import * as GameFolder from "../games/GameFolder.ts";
import * as StateFolder from "../state/StateFolder.ts";
import type * as Games from "../games/Games.ts";
import { codeVersion } from "../runningCommit.ts";
import * as ImageTexts from "./ImageTexts.ts";

const fontFile = (name: string) => {
  const family = name.startsWith("noto-serif") ? "noto-serif" : "noto-sans";
  return fileURLToPath(import.meta.resolve(`@fontsource/${family}/files/${name}.woff2`));
};

/** The files of the bundled lettering fonts, regular and bold; the portable download has its own. */
export const LetteringFontFiles = Context.Reference<{
  readonly sans: readonly [string, string];
  readonly serif: readonly [string, string];
}>("@rpgtl/server/imageText/LetteringFontFiles", {
  defaultValue: () => ({
    sans: [fontFile("noto-sans-latin-400-normal"), fontFile("noto-sans-latin-700-normal")],
    serif: [fontFile("noto-serif-latin-400-normal"), fontFile("noto-serif-latin-700-normal")],
  }),
});

/** An XP game's image with English drawn in, and its tiles' PNG. */
export interface DrawnXpImage extends XpLetteredImage {
  readonly bytes: Uint8Array;
}

/**
 * The images of XP games with their English drawn in, which `Game.exe` and mkxp-z can't draw
 * themselves. The game gets only the parts that differ from its own images, never whole pictures.
 */
export class XpImages extends Context.Service<
  XpImages,
  {
    /**
     * The game's images with translated text, as the tiles that differ from its own images. Only
     * images whose game file, English or RPGTL changed since they were last drawn are drawn
     * again. An image that can't be drawn is left out with a warning, so it plays untranslated.
     */
    readonly drawn: (game: Game) => Effect.Effect<ReadonlyArray<DrawnXpImage>, XpImagesError>;
  }
>()("@rpgtl/server/imageText/XpImages") {}

type XpImagesError = Games.GameNotInspectedError | StateFolder.StateFileError;

const Places = Schema.Array(Schema.Int);
const decodePlaces = Schema.decodeUnknownOption(Schema.fromJsonString(Places));

const newCanvas = (width: number, height: number) => {
  const canvas = createCanvas(width, height);
  return { canvas, context: canvas.getContext("2d") };
};

const pixelsOf = (canvas: Canvas): Pixels => {
  const { width, height } = canvas;
  return {
    width,
    height,
    data: new Uint8Array(canvas.getContext("2d").getImageData(0, 0, width, height).data),
  };
};

/** An image that the canvas couldn't decode or draw. */
class ImageDrawError extends Schema.TaggedError<ImageDrawError>()("ImageDrawError", {
  cause: Schema.Defect(),
}) {}

const decoded = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () => loadImage(bytes),
    catch: (cause) => new ImageDrawError({ cause }),
  });

/** The tiles of `original` that differ once the English of `hint` is drawn on `erased`. */
const drawTiles = Effect.fnUntraced(function* (
  original: Uint8Array,
  erased: Uint8Array,
  hint: ImageTextHint,
) {
  const [image, background] = yield* Effect.all([decoded(original), decoded(erased)]);
  return yield* Effect.try({
    try: () => tilesOf(image, background, hint),
    catch: (cause) => new ImageDrawError({ cause }),
  });
});

function tilesOf(image: Image, background: Image, hint: ImageTextHint) {
  const { canvas, context } = newCanvas(image.width, image.height);
  context.drawImage(image, 0, 0);
  const before = pixelsOf(canvas);
  const face = `rpgtl-lettering-${hint.font ?? "sans"}`;
  drawImageText<Image | Canvas>(
    context,
    background,
    hint.blocks,
    face,
    hint.series ?? [],
    newCanvas,
  );
  const patches = erasedPatches(before, pixelsOf(canvas));
  const width = Math.max(1, ...patches.map((patch) => patch.width));
  const tiles = new PNG({
    width,
    height: Math.max(
      1,
      patches.reduce((sum, patch) => sum + patch.height, 0),
    ),
    filterType: 4,
  });
  tiles.data.fill(0);
  const places: Array<number> = [];
  let top = 0;
  for (const patch of patches) {
    for (let row = 0; row < patch.height; row++)
      tiles.data.set(
        patch.data.subarray(row * patch.width * 4, (row + 1) * patch.width * 4),
        (top + row) * width * 4,
      );
    places.push(patch.x, patch.y, top, patch.width, patch.height);
    top += patch.height;
  }
  return { bytes: new Uint8Array(PNG.sync.write(tiles, { filterType: 4 })), places };
}

const make = Effect.gen(function* () {
  const catalogs = yield* Catalogs.Catalogs;
  const gameFolder = yield* GameFolder.GameFolder;
  const imageTexts = yield* ImageTexts.ImageTexts;
  const folder = yield* StateFolder.StateFolder;
  const writer = yield* codeVersion;
  const fonts = yield* LetteringFontFiles;
  for (const font of ["sans", "serif"] as const)
    for (const file of fonts[font]) GlobalFonts.registerFromPath(file, `rpgtl-lettering-${font}`);

  const drawn = Effect.fn("XpImages.drawn")(function* (game: Game) {
    const cache = gameFiles(game.id).letteredImages;
    const catalog = yield* catalogs.get(game.id);
    const results = yield* imageTexts.results(game.id);
    const font = imageFontOf(game.engine, catalog.imageFont);
    const hints = imageTextHints(
      results,
      { ...catalog, ...(font && { imageFont: font }) },
      (erased) => erased,
    );
    const kept = new Set<string>();
    const images: Array<DrawnXpImage> = [];
    for (const [image, hint] of Object.entries(hints)) {
      const result = results.images[image];
      if (!result) continue;
      const print = createHash("sha256")
        .update(JSON.stringify([writer, image, result.sha256, hint]))
        .digest("hex");
      const tiles = `${xpImageFolder}/${print}`;
      kept.add(`${print}.png`).add(`${print}.json`);
      const original = yield* gameFolder.readFile(game, result.file).pipe(
        Effect.asSome,
        Effect.catchTags({
          GameFileMissingError: () => Effect.succeedNone,
          GameFileReadError: () => Effect.succeedNone,
        }),
      );
      if (Option.isNone(original) || imageHash(original.value) !== result.sha256) {
        yield* Effect.logWarning(`${image} plays untranslated: it changed since it was read.`);
        continue;
      }
      const saved = yield* Effect.all([
        folder.readBytes(`${cache}/${print}.png`),
        Effect.map(folder.readBytes(`${cache}/${print}.json`), (bytes) =>
          decodePlaces(new TextDecoder().decode(bytes)),
        ),
      ]).pipe(Effect.asSome, Effect.catchTags({ StateFileError: () => Effect.succeedNone }));
      if (Option.isSome(saved) && Option.isSome(saved.value[1])) {
        images.push({ image, tiles, places: saved.value[1].value, bytes: saved.value[0] });
        continue;
      }
      const erased = yield* folder
        .readBytes(`${gameFiles(game.id).erasedImages}/${hint.erased}`)
        .pipe(Effect.asSome, Effect.catchTags({ StateFileError: () => Effect.succeedNone }));
      if (Option.isNone(erased)) {
        yield* Effect.logWarning(`${image} plays untranslated: its erased background is missing.`);
        continue;
      }
      const done = yield* drawTiles(original.value, erased.value, hint).pipe(
        Effect.asSome,
        Effect.catchTags({
          ImageDrawError: (error) =>
            Effect.as(
              Effect.logWarning(`${image} plays untranslated: it couldn't be drawn.`, error),
              Option.none(),
            ),
        }),
      );
      if (Option.isNone(done)) continue;
      yield* folder.writeBytes(`${cache}/${print}.png`, done.value.bytes);
      yield* folder.writeBytes(
        `${cache}/${print}.json`,
        new TextEncoder().encode(JSON.stringify(done.value.places)),
      );
      images.push({ image, tiles, ...done.value });
    }
    for (const name of yield* folder.list(cache))
      if (!kept.has(name)) yield* folder.remove(`${cache}/${name}`);
    return images;
  });

  return XpImages.of({ drawn });
});

export const layer = Layer.effect(XpImages, make);
