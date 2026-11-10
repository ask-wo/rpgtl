import { gameFiles, ImageReadResults } from "@rpgtl/contracts";
import { erasedName, type ImageTextFiles } from "@rpgtl/domain";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as StateFolder from "../state/StateFolder.ts";

const noResults: ImageReadResults = { version: 1, images: {} };

/**
 * Each game's image text as the state folder keeps it: what the image reader found in its images
 * (`games/<game id>/images.json`) and their erased backgrounds (`games/<game id>/images/`).
 */
export class ImageTexts extends Context.Service<
  ImageTexts,
  {
    /** The path of the erased background `name`; none when the game has no such file. */
    readonly erasedImage: (
      id: string,
      name: string,
    ) => Effect.Effect<Option.Option<string>, StateFolder.StateFileError>;
    /** The game's read results; none read yet is an empty set. */
    readonly results: (id: string) => Effect.Effect<ImageReadResults, StateFolder.StateFileError>;
    /** The read results and the erased backgrounds they use; none without results. */
    readonly exported: (
      id: string,
    ) => Effect.Effect<Option.Option<ImageTextFiles>, StateFolder.StateFileError>;
    /** Saves an erased background and gives its file name. */
    readonly saveErased: (
      id: string,
      bytes: Uint8Array,
    ) => Effect.Effect<string, StateFolder.StateFileError>;
    readonly save: (
      id: string,
      results: ImageReadResults,
    ) => Effect.Effect<void, StateFolder.StateFileError>;
    /** Removes the erased backgrounds none of the saved results uses. */
    readonly removeUnused: (id: string) => Effect.Effect<void, StateFolder.StateFileError>;
    /** Replaces the game's image text with a translation file's. */
    readonly replace: (
      id: string,
      imageText: ImageTextFiles,
    ) => Effect.Effect<void, StateFolder.StateFileError>;
    /** Deletes the read results and the erased backgrounds. */
    readonly clear: (id: string) => Effect.Effect<void, StateFolder.StateFileError>;
  }
>()("@rpgtl/server/imageText/ImageTexts") {}

const make = Effect.gen(function* () {
  const folder = yield* StateFolder.StateFolder;
  const path = yield* Path.Path;

  const erasedImage = Effect.fn("ImageTexts.erasedImage")(function* (id: string, name: string) {
    const names = yield* folder.list(gameFiles(id).erasedImages);
    return names.includes(name)
      ? Option.some(path.join(folder.root, gameFiles(id).erasedImages, name))
      : Option.none<string>();
  });

  const results = Effect.fn("ImageTexts.results")(function* (id: string) {
    return Option.getOrElse(
      yield* folder.read(gameFiles(id).imageResults, ImageReadResults),
      () => noResults,
    );
  });

  const exported = Effect.fn("ImageTexts.exported")(function* (id: string) {
    const saved = yield* results(id);
    if (Object.keys(saved.images).length === 0) return Option.none<ImageTextFiles>();
    const names = new Set(Object.values(saved.images).flatMap((result) => result.erased ?? []));
    const erased = new Map<string, Uint8Array>();
    for (const name of names)
      erased.set(name, yield* folder.readBytes(`${gameFiles(id).erasedImages}/${name}`));
    return Option.some({ results: saved, erased });
  });

  const saveErased = Effect.fn("ImageTexts.saveErased")(function* (id: string, bytes: Uint8Array) {
    const name = erasedName(bytes);
    yield* folder.writeBytes(`${gameFiles(id).erasedImages}/${name}`, bytes);
    return name;
  });

  const save = Effect.fn("ImageTexts.save")(function* (id: string, next: ImageReadResults) {
    yield* folder.write(gameFiles(id).imageResults, ImageReadResults, next);
  });

  const removeUnused = Effect.fn("ImageTexts.removeUnused")(function* (id: string) {
    const saved = yield* results(id);
    const used = new Set(Object.values(saved.images).map((result) => result.erased));
    for (const name of yield* folder.list(gameFiles(id).erasedImages))
      if (!used.has(name)) yield* folder.remove(`${gameFiles(id).erasedImages}/${name}`);
  });

  const replace = Effect.fn("ImageTexts.replace")(function* (
    id: string,
    imageText: ImageTextFiles,
  ) {
    for (const [name, bytes] of imageText.erased)
      yield* folder.writeBytes(`${gameFiles(id).erasedImages}/${name}`, bytes);
    yield* save(id, imageText.results);
    yield* removeUnused(id);
  }, Effect.uninterruptible);

  const clear = Effect.fn("ImageTexts.clear")(function* (id: string) {
    yield* folder.remove(gameFiles(id).imageResults);
    yield* folder.remove(gameFiles(id).erasedImages);
  }, Effect.uninterruptible);

  return ImageTexts.of({
    erasedImage,
    results,
    exported,
    saveErased,
    save,
    removeUnused,
    replace,
    clear,
  });
});

export const layer = Layer.effect(ImageTexts, make);
