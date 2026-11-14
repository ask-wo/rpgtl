import { type ImageReadResults } from "@rpgtl/contracts";
import { erasedName, imageEntries, imageHash, writeArchive } from "@rpgtl/domain";
import { rubyObject, xpFile } from "@rpgtl/domain/testUtils/xpGame";
import * as Effect from "effect/Effect";
import * as Catalogs from "../games/Catalogs.ts";
import * as ImageTexts from "../imageText/ImageTexts.ts";
import { folderWith } from "./gameFolder.ts";
import { greyPng } from "./png.ts";
import { opened } from "./state.ts";

const box = [8, 8, 40, 24] as const;
const sign = greyPng(64, 32);
// White where the text was, as if the reader erased it.
const erased = greyPng(
  64,
  32,
  Array.from({ length: 32 * 16 }, (_, at) => [8 + (at % 32), 8 + Math.floor(at / 32)] as const),
);

const results: ImageReadResults = {
  version: 1,
  images: {
    "Graphics/Pictures/Sign": {
      file: "Graphics/Pictures/Sign.png",
      sha256: imageHash(sign),
      width: 64,
      height: 32,
      lines: [
        {
          text: "出口",
          score: 0.99,
          contrast: 255,
          box: [...box],
          polygon: [
            [8, 8],
            [40, 8],
            [40, 24],
            [8, 24],
          ],
          reader: "paddle",
        },
      ],
      erased: erasedName(erased),
      blocks: [
        {
          lines: [0],
          grow: 0,
          polygons: [],
          area: [...box],
          lineHeight: 16,
          space: [0, 0, 64, 32],
          fill: "#ff0000",
          outline: null,
          stroke: 0,
          weight: 0.12,
          bold: false,
          align: "centre",
          group: 0,
        },
      ],
    },
  },
};

/**
 * An XP game whose archive holds a sign, read and translated as `english`, with its translation
 * switch on.
 */
export const translatedSign = Effect.fnUntraced(function* (english: string) {
  const catalogs = yield* Catalogs.Catalogs;
  const imageTexts = yield* ImageTexts.ImageTexts;
  const dir = yield* folderWith({
    "Game.rgssad": writeArchive(
      new Map([
        ["Data/System.rxdata", xpFile(rubyObject("RPG::System", {}))],
        ["Graphics/Pictures/Sign.png", sign],
      ]),
    ),
  });
  const { game, catalog } = yield* opened(catalogs.inspect(dir));
  yield* imageTexts.saveErased(game.id, erased);
  yield* imageTexts.save(game.id, results);
  yield* catalogs.save({
    ...catalog,
    translate: true,
    entries: imageEntries(results).map((entry) => ({ ...entry, translation: { user: english } })),
  });
  return game;
});
