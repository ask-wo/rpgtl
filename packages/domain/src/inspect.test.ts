import { assert, it } from "@effect/vitest";
import {
  assetNames,
  mediaNames,
  mediaReferences,
  inspectedEntries,
  mediaWarnings,
  missingFiles,
  newEntry,
} from "./index.ts";
import { testCatalog } from "./testUtils/catalog.ts";

it("audio and video NW.js can't play are named unless a counterpart it can play is there", () => {
  const files = ["audio/bgm/Town.m4a", "audio/bgm/Town.ogg", "audio/se/Door.M4A", "movies/Op.mp4"];
  assert.deepStrictEqual(mediaWarnings(files), [
    "audio/se/Door.M4A has no .ogg counterpart; NW.js cannot play AAC audio.",
    "movies/Op.mp4 has no .webm counterpart; NW.js cannot play H.264 video.",
  ]);
});

it("an image is missing unless its folder has it, in any case, and faces name the faces asked for", () => {
  const map = {
    events: [
      null,
      {
        pages: [
          {
            image: { characterName: "Hero" },
            list: [
              { code: 101, parameters: ["$Arlene", 3, 0, 2] },
              { code: 231, parameters: [1, "Title"] },
            ],
          },
        ],
      },
    ],
  };
  const actors = [null, { faceName: "$Arlene", faceIndex: 1, characterName: "hero" }];
  const references = [
    ...mediaReferences("Map001.json", map),
    ...mediaReferences("Actors.json", actors),
  ];
  const folders = new Map([
    ["img/characters/", mediaNames("img/characters/", ["HERO.png"])],
    ["img/faces/", mediaNames("img/faces/", ["Actor1.png", "Actor1.rpgmvp", "notes.txt"])],
    ["img/pictures/", mediaNames("img/pictures/", ["Title.png_"])],
  ]);
  assert.deepStrictEqual(missingFiles(references, folders), [
    { path: "img/faces/$Arlene", files: ["Actors.json", "Map001.json"] },
  ]);
});

const sound = (name: string) => ({ name, volume: 90, pitch: 100, pan: 0 });

it("a sound is missing unless its folder has it in any format, and a map's music only if it plays", () => {
  const map = {
    autoplayBgm: false,
    bgm: sound("Unused"),
    autoplayBgs: true,
    bgs: sound("Rain"),
    events: [
      null,
      {
        pages: [
          {
            list: [
              { code: 241, parameters: [sound("Duel")] },
              { code: 250, parameters: [sound("")] },
              {
                code: 205,
                parameters: [-1, { list: [{ code: 44, parameters: [sound("Step")] }] }],
              },
            ],
          },
        ],
      },
    ],
  };
  const system = { titleBgm: sound("theme"), sounds: [sound("Cursor"), sound("")] };
  const references = [
    ...mediaReferences("Map001.json", map),
    ...mediaReferences("System.json", system),
  ];
  const folders = new Map([
    ["audio/bgm/", mediaNames("audio/bgm/", ["Theme.ogg", "Duel.mid"])],
    ["audio/bgs/", mediaNames("audio/bgs/", ["Rain.rpgmvo"])],
    ["audio/se/", mediaNames("audio/se/", ["Cursor.m4a"])],
  ]);
  assert.deepStrictEqual(missingFiles(references, folders), [
    { path: "audio/se/Step", files: ["Map001.json"] },
  ]);
});

it("asset names are the paths below img, audio and movies, with and without their folders", () => {
  assert.deepStrictEqual(
    [...assetNames(["img/pictures/合成物品.png", "audio/se/a.b.ogg", "js/main.js"])],
    ["pictures/合成物品", "合成物品", "img/pictures/合成物品", "se/a.b", "a.b", "audio/se/a.b"],
  );
});

it("inspecting again keeps an image text the user corrected and an entry left untranslated", () => {
  const read = newEntry({ _tag: "ImageLines", image: "img/pictures/Sign", lines: [0] }, "开使");
  const name = newEntry({ _tag: "EventName", map: 1, event: 1 }, "客人");
  const previous = testCatalog({
    entries: [
      { ...read, source: "开始", userTranslation: "Start", isLeftUntranslated: true },
      { ...name, isLeftUntranslated: true },
    ],
  });
  assert.deepStrictEqual(inspectedEntries([read, name], previous), [
    { ...read, source: "开始", isInImage: true, isLeftUntranslated: true },
    { ...name, isInImage: false },
  ]);
  assert.deepStrictEqual(inspectedEntries([read], undefined), [{ ...read, isInImage: true }]);
});
