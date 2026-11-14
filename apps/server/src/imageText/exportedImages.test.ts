import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ImageResult } from "@rpgtl/contracts";
import { erasedName, imageHash, writeArchive } from "@rpgtl/domain";
import { rubyObject, xpFile } from "@rpgtl/domain/testUtils/xpGame";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as GameFolder from "../games/GameFolder.ts";
import { folderWith, mvGame } from "../testUtils/gameFolder.ts";
import { encryptedImage } from "../testUtils/imageReader.ts";
import { greyPng, pixelsOf } from "../testUtils/png.ts";
import { exportedImageText, importedImageFiles } from "./exportedImages.ts";

const services = GameFolder.layer.pipe(Layer.provideMerge(NodeServices.layer));
const key = "0123456789abcdef0123456789abcdef";

const result = (file: string, bytes: Uint8Array, erased?: string): ImageResult => ({
  file,
  sha256: imageHash(bytes),
  width: 40,
  height: 40,
  lines: [],
  ...(erased && { erased }),
});

/** A game with encrypted pictures, and erased backgrounds of two of them. */
const setUp = Effect.gen(function* () {
  const sign = encryptedImage(greyPng(40, 40), key);
  const notice = encryptedImage(greyPng(40, 40), key);
  const root = yield* folderWith({
    ...mvGame,
    "www/data/System.json": JSON.stringify({
      gameTitle: "雨",
      encryptionKey: key,
      hasEncryptedImages: true,
    }),
    "www/img/pictures/Sign.rpgmvp": sign,
    "www/img/pictures/Notice.rpgmvp": notice,
  });
  const game = yield* GameFolder.GameFolder.use((folder) => folder.inspect(root));
  const signErased = greyPng(40, 40, [[5, 5]]);
  const noticeErased = greyPng(40, 40, [[30, 35]]);
  const files = {
    results: {
      version: 1 as const,
      images: {
        "img/pictures/Sign": result("img/pictures/Sign.rpgmvp", sign, erasedName(signErased)),
        "img/pictures/Notice": result(
          "img/pictures/Notice.rpgmvp",
          notice,
          erasedName(noticeErased),
        ),
        "img/pictures/Gone": result("img/pictures/Gone.rpgmvp", greyPng(4, 4), "gone.png"),
        "img/pictures/Plain": result("img/pictures/Plain.rpgmvp", greyPng(4, 4)),
      },
    },
    erased: new Map([
      [erasedName(signErased), signErased],
      [erasedName(noticeErased), noticeErased],
      ["gone.png", greyPng(4, 4, [[1, 1]])],
    ]),
  };
  return { game, files, signErased, noticeErased };
});

it.effect(
  "an export carries only what differs from the game's images, and import draws it back; a background whose image is gone is left out",
  () =>
    Effect.gen(function* () {
      const { game, files, signErased, noticeErased } = yield* setUp;
      const exported = Option.getOrThrow(yield* exportedImageText(game, files));
      assert.deepStrictEqual(Object.keys(exported.images), [
        "img/pictures/Sign",
        "img/pictures/Notice",
        "img/pictures/Plain",
      ]);
      const sign = exported.images["img/pictures/Sign"]?.erased ?? [];
      assert.deepStrictEqual(
        sign.map(({ x, y }) => [x, y]),
        [[0, 0]],
      );

      assert.notProperty(exported.images["img/pictures/Sign"], "file");

      const imported = yield* importedImageFiles(game, exported, () => Effect.void);
      // Each image's file comes back from its path and the game's image extension.
      assert.strictEqual(
        imported.results.images["img/pictures/Sign"]?.file,
        "img/pictures/Sign.rpgmvp",
      );
      for (const [image, erased] of [
        ["img/pictures/Sign", signErased],
        ["img/pictures/Notice", noticeErased],
      ] as const) {
        const name = imported.results.images[image]?.erased ?? "";
        assert.deepStrictEqual(
          pixelsOf(imported.erased.get(name) ?? new Uint8Array()),
          pixelsOf(erased),
        );
      }
    }).pipe(Effect.provide(services)),
);

it.effect(
  "an XP game's image text goes through a translation file with each image's own file, from its archive",
  () =>
    Effect.gen(function* () {
      const sign = greyPng(40, 40);
      const erased = greyPng(40, 40, [[5, 5]]);
      const root = yield* folderWith({
        "Game.rgssad": writeArchive(
          new Map([
            ["Data/System.rxdata", xpFile(rubyObject("RPG::System", {}))],
            ["Graphics/Titles/Cover.png", sign],
            ["Graphics/Pictures/Note.jpg", new Uint8Array([255, 216, 255])],
          ]),
        ),
      });
      const game = yield* GameFolder.GameFolder.use((folder) => folder.inspect(root));
      const files = {
        results: {
          version: 1 as const,
          images: {
            "Graphics/Titles/Cover": result("Graphics/Titles/Cover.png", sign, erasedName(erased)),
            "Graphics/Pictures/Note": result("Graphics/Pictures/Note.jpg", sign),
          },
        },
        erased: new Map([[erasedName(erased), erased]]),
      };
      const exported = Option.getOrThrow(yield* exportedImageText(game, files));
      const imported = yield* importedImageFiles(game, exported, () => Effect.void);
      const cover = imported.results.images["Graphics/Titles/Cover"];
      assert.strictEqual(cover?.file, "Graphics/Titles/Cover.png");
      assert.strictEqual(
        imported.results.images["Graphics/Pictures/Note"]?.file,
        "Graphics/Pictures/Note.jpg",
      );
      assert.deepStrictEqual(
        pixelsOf(imported.erased.get(cover?.erased ?? "") ?? new Uint8Array()),
        pixelsOf(erased),
      );
    }).pipe(Effect.provide(services)),
);

it.effect(
  "import leaves out erased backgrounds of images this game doesn't have as they were read",
  () =>
    Effect.gen(function* () {
      const { game, files } = yield* setUp;
      const exported = Option.getOrThrow(yield* exportedImageText(game, files));
      const sign = exported.images["img/pictures/Sign"];
      const changed = {
        images: {
          ...exported.images,
          ...(sign && { "img/pictures/Sign": { ...sign, sha256: "other" } }),
        },
      };
      const imported = yield* importedImageFiles(game, changed, () => Effect.void);
      assert.deepStrictEqual(Object.keys(imported.results.images), [
        "img/pictures/Notice",
        "img/pictures/Plain",
      ]);
      assert.strictEqual(imported.erased.size, 1);
    }).pipe(Effect.provide(services)),
);

it.effect("a patch that isn't a PNG or reaches outside its image fails the import", () =>
  Effect.gen(function* () {
    const { game, files } = yield* setUp;
    const exported = Option.getOrThrow(yield* exportedImageText(game, files));
    const sign = exported.images["img/pictures/Sign"];
    for (const patch of [
      { x: 0, y: 0, png: new Uint8Array([1, 2, 3]) },
      { x: 30, y: 0, png: greyPng(16, 16) },
    ]) {
      const error = yield* Effect.flip(
        importedImageFiles(
          game,
          {
            images: {
              ...exported.images,
              ...(sign && { "img/pictures/Sign": { ...sign, erased: [patch] } }),
            },
          },
          () => Effect.void,
        ),
      );
      assert.strictEqual(error.problem, "images");
    }
  }).pipe(Effect.provide(services)),
);
