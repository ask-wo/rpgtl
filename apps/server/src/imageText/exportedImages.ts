import type { ExportedImage, ExportedImageText, ImageResult } from "@rpgtl/contracts";
import {
  decryptImage,
  erasedName,
  erasedPatches,
  imageHash,
  namedRuns,
  readResults,
  type ImageTextFiles,
  type Pixels,
  TranslationFileInvalid,
  withPatches,
} from "@rpgtl/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { PNG } from "pngjs";
import * as GameFolder from "../games/GameFolder.ts";
import type { FolderGame } from "../games/GameFolder.ts";

const decode = (bytes: Uint8Array) =>
  Result.try((): Pixels => {
    const png = PNG.sync.read(Buffer.from(bytes));
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
  });

// Paeth filtering alone compresses as well as trying every filter, in a third of the time.
const encode = ({ width, height, data }: Pixels) => {
  const png = new PNG({ width, height, filterType: 4 });
  png.data = Buffer.from(data);
  return new Uint8Array(PNG.sync.write(png, { filterType: 4 }));
};

/**
 * What the game's image file holds, while it is still the file `result` was read from; none when
 * the game no longer has it as it was.
 */
const unchangedImage = Effect.fnUntraced(function* (game: FolderGame, result: ImageResult) {
  const bytes = yield* GameFolder.GameFolder.use((folder) =>
    folder.readFile(game, result.file),
  ).pipe(
    Effect.asSome,
    Effect.catchTags({
      GameFileMissingError: () => Effect.succeedNone,
      GameFileReadError: () => Effect.succeedNone,
    }),
  );
  return Option.filter(bytes, (file) => imageHash(file) === result.sha256);
});

/** The pixels of the game's image file, decrypted with `key`; none when it isn't a PNG. */
const pixels = (bytes: Uint8Array, key: Option.Option<string>) =>
  Result.getSuccess(
    Result.flatMap(decryptImage(bytes, Option.getOrUndefined(key)), (image) => decode(image)),
  );

/** The game's image encoding; plain PNGs when its System.json can't be read. */
const gameEncoding = (game: FolderGame) => {
  const plain = Effect.succeed({ extension: ".png", key: Option.none<string>() });
  return GameFolder.GameFolder.use((folder) => folder.imageEncoding(game)).pipe(
    Effect.catchTags({
      GameFileMissingError: () => plain,
      GameFileReadError: () => plain,
      GameFileInvalid: () => plain,
    }),
  );
};

/**
 * The file of each of the game's images by its path: the path with the game's image extension,
 * or for an XP game, whose images have no single extension, the file it has.
 */
const imageFiles = Effect.fnUntraced(function* (game: FolderGame) {
  const { extension } = yield* gameEncoding(game);
  if (game.engine !== "XP") return (image: string) => `${image}${extension}`;
  const files = yield* GameFolder.GameFolder.use((folder) => folder.textImages(game)).pipe(
    Effect.map(({ images }) => new Map(images.map(({ image, file }) => [image, file]))),
    Effect.catchTags({
      GameFileMissingError: () => Effect.succeed(new Map<string, string>()),
      GameFileReadError: () => Effect.succeed(new Map<string, string>()),
      GameFileInvalid: () => Effect.succeed(new Map<string, string>()),
    }),
  );
  return (image: string) => files.get(image) ?? `${image}${extension}`;
});

/**
 * The game's image text as a translation file carries it: each erased background as the patches
 * that differ from the game's image. An erased background whose image the game no longer has as
 * it was read can't be put together again, so its result is left out; none when no result is left.
 */
export const exportedImageText = Effect.fn("exportedImageText")(function* (
  game: FolderGame,
  files: ImageTextFiles,
) {
  const { key } = yield* gameEncoding(game);
  const images: Record<string, ExportedImage> = {};
  for (const [image, result] of Object.entries(files.results.images)) {
    const { file: _, erased: name, ...kept } = result;
    if (!name) {
      images[image] = kept;
      continue;
    }
    yield* Effect.yieldNow;
    const bytes = yield* unchangedImage(game, result);
    if (Option.isNone(bytes)) continue;
    const original = pixels(bytes.value, key);
    const saved = files.erased.get(name);
    const erased = saved ? Result.getSuccess(decode(saved)) : Option.none();
    if (Option.isNone(original) || Option.isNone(erased)) continue;
    if (original.value.width !== erased.value.width) continue;
    if (original.value.height !== erased.value.height) continue;
    images[image] = {
      ...kept,
      erased: erasedPatches(original.value, erased.value).map((patch) => ({
        x: patch.x,
        y: patch.y,
        png: encode(patch),
      })),
    };
  }
  return Object.keys(images).length
    ? Option.some<ExportedImageText>({
        images,
        ...namedRuns(Object.values(images), files.results.runs),
      })
    : Option.none<ExportedImageText>();
});

/**
 * A translation file's image text put together again: each image's file is the game's file of its
 * path, as the engine loads it, and each erased background is the game's image
 * with the file's patches drawn over it. A result whose image this game doesn't have as it was
 * read is left out when it has an erased background. Fails when a patch isn't a PNG or reaches
 * outside its image.
 */
export const importedImageFiles = Effect.fn("importedImageFiles")(function* (
  game: FolderGame,
  imported: ExportedImageText,
  progress: (done: number) => Effect.Effect<void>,
) {
  const { key } = yield* gameEncoding(game);
  const fileOf = yield* imageFiles(game);
  const damaged = new TranslationFileInvalid({ problem: "images" });
  const images: Record<string, ImageResult> = {};
  const erased = new Map<string, Uint8Array>();
  for (const [done, [image, { erased: patched, ...exported }]] of Object.entries(
    imported.images,
  ).entries()) {
    yield* progress(done);
    const result = { ...exported, file: fileOf(image) };
    if (!patched) {
      images[image] = result;
      continue;
    }
    yield* Effect.yieldNow;
    const bytes = yield* unchangedImage(game, result);
    if (Option.isNone(bytes)) continue;
    const original = pixels(bytes.value, key);
    if (Option.isNone(original)) continue;
    const patches = [];
    for (const patch of patched) {
      const decoded = decode(patch.png);
      if (Result.isFailure(decoded)) return yield* damaged;
      patches.push({ ...decoded.success, x: patch.x, y: patch.y });
    }
    const drawn = withPatches(original.value, patches);
    if (!drawn) return yield* damaged;
    const png = encode(drawn);
    const name = erasedName(png);
    erased.set(name, png);
    images[image] = { ...result, erased: name };
  }
  return { results: readResults(images, imported.runs), erased } satisfies ImageTextFiles;
});

/**
 * The read results `importedImageFiles` makes of a translation file's image text, without putting
 * the erased backgrounds together: enough to count what an import changes.
 */
export const importedImageResults = Effect.fn("importedImageResults")(function* (
  game: FolderGame,
  imported: ExportedImageText,
) {
  const fileOf = yield* imageFiles(game);
  const images: Record<string, ImageResult> = {};
  for (const [image, { erased: _, ...exported }] of Object.entries(imported.images))
    images[image] = { ...exported, file: fileOf(image) };
  return readResults(images, imported.runs);
});
