import { gameFiles } from "@rpgtl/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { Catalog, ImageReadResults } from "@rpgtl/contracts";
import { imageEntries } from "@rpgtl/domain";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Catalogs from "../games/Catalogs.ts";
import * as ImageTexts from "../imageText/ImageTexts.ts";
import * as Settings from "../settings/Settings.ts";
import { folderWith, mvGame } from "../testUtils/gameFolder.ts";
import { opened, servicesWith } from "../testUtils/state.ts";
import * as Play from "./Play.ts";

const services = Play.layer.pipe(
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(servicesWith({})),
  Layer.provideMerge(NodeServices.layer),
);

const translations: Record<string, string> = { 你好: "Hello", 标题: "Title", 门开了: "Door open" };

/** Inspects `files` as a game, saves the translations above into its catalog and turns it on. */
const translatedGame = Effect.fnUntraced(function* (
  files: Record<string, string>,
  change: (catalog: Catalog) => Catalog = (catalog) => catalog,
) {
  const catalogs = yield* Catalogs.Catalogs;
  const dir = yield* folderWith(files);
  const { game, catalog } = yield* opened(catalogs.inspect(dir));
  yield* catalogs.save(
    change({
      ...catalog,
      translate: true,
      entries: catalog.entries.map((entry) => ({
        ...entry,
        translation: { user: translations[entry.source] ?? "" },
      })),
    }),
  );
  return game;
});

const contents = (file: Play.PlayFile) =>
  Play.PlayFile.$match(file, {
    Made: ({ text }) => text,
    Stored: ({ path }) => `stored ${path}`,
  });

it.effect(
  "the game shows the catalog's text while its translation switch is on and its own while off, with the runtime in both",
  () =>
    Effect.gen(function* () {
      const play = yield* Play.Play;
      const settings = yield* Settings.Settings;
      const path = yield* Path.Path;
      const game = yield* translatedGame(mvGame);
      yield* settings.save({ ...(yield* settings.get), sharpText: true });

      const map = yield* play.file(game.id, "data/Map001.json");
      assert.include(contents(map), '"Hello"');
      assert.notInclude(contents(map), "你好");
      const plugins = yield* play.file(game.id, "js/plugins.js");
      assert.strictEqual(
        plugins._tag === "Made" && plugins.contentType,
        "text/javascript; charset=utf-8",
      );
      assert.include(contents(plugins), '"title":"Title"');
      const system = JSON.parse(contents(yield* play.file(game.id, "data/System.json")));
      assert.deepStrictEqual(system.switches, ["", "门开了"]);
      assert.deepStrictEqual(system.rpgtlNames.switches, { "1": "Door open" });

      const catalogs = yield* Catalogs.Catalogs;
      const translatedPage = contents(yield* play.file(game.id, ""));
      yield* catalogs.setTranslate(game.id, false);
      const original = path.join(game.webRoot, "data", "Map001.json");
      assert.deepStrictEqual(
        yield* play.file(game.id, "data/Map001.json"),
        Play.PlayFile.Stored({ path: original }),
      );
      assert.include(
        yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readFileString(original))),
        "你好",
      );
      assert.strictEqual((yield* play.file(game.id, "js/plugins.js"))._tag, "Stored");
      const originalSystem = JSON.parse(contents(yield* play.file(game.id, "data/System.json")));
      assert.deepStrictEqual(originalSystem.switches, ["", "门开了"]);
      assert.notProperty(originalSystem, "rpgtlNames");

      for (const page of [translatedPage, contents(yield* play.file(game.id, ""))]) {
        assert.include(
          page,
          `<script>window.rpgtlSharpPixels = false; window.rpgtlSharpText = true;</script>` +
            `<script src="/runtime.js" data-game="${game.id}"></script><script src="/map-view.js"></script>`,
        );
      }
    }).pipe(Effect.provide(services)),
);

it.effect(
  "files are found in any letter case, and nothing outside the game's folder is served",
  () =>
    Effect.gen(function* () {
      const play = yield* Play.Play;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outside = yield* folderWith({ "secret.txt": "secret" });
      const game = yield* translatedGame(mvGame);
      yield* fs.symlink(path.join(outside, "secret.txt"), path.join(game.webRoot, "link.txt"));
      yield* fs.symlink(path.join(outside, "gone"), path.join(game.webRoot, "broken"));

      assert.include(contents(yield* play.file(game.id, "DATA/map001.JSON")), '"Hello"');
      for (const relative of [
        "../Game.exe",
        "link.txt",
        "data/../../Game.exe",
        "missing.png",
        "index.html/x",
        "broken/a.png",
      ]) {
        const error = yield* Effect.flip(play.file(game.id, relative));
        assert.strictEqual(error._tag, "GameFileMissingError", relative);
      }
      const unknown = yield* Effect.flip(play.file("ffffffffffffffffffff", "index.html"));
      assert.strictEqual(unknown._tag, "GameNotInspectedError");
    }).pipe(Effect.provide(services)),
);

it.effect(
  "a data file changed since inspecting is an error, and plays as it is with the switch off",
  () =>
    Effect.gen(function* () {
      const play = yield* Play.Play;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const game = yield* translatedGame(mvGame);
      const map = path.join(game.webRoot, "data", "Map001.json");
      yield* fs.writeFileString(map, (yield* fs.readFileString(map)).replace("你好", "再见"));

      const error = yield* Effect.flip(play.file(game.id, "data/Map001.json"));
      assert.strictEqual(error._tag, "GameDataChanged");
      yield* (yield* Catalogs.Catalogs).setTranslate(game.id, false);
      assert.strictEqual((yield* play.file(game.id, "data/Map001.json"))._tag, "Stored");
    }).pipe(Effect.provide(services)),
);

it.effect("an erased background is found only by its own name, and only for a listed game", () =>
  Effect.gen(function* () {
    const play = yield* Play.Play;
    const imageTexts = yield* ImageTexts.ImageTexts;
    const game = yield* translatedGame(mvGame);
    const name = yield* imageTexts.saveErased(game.id, new Uint8Array([1, 2, 3]));

    const found = yield* play.erasedImage(game.id, name);
    assert.isTrue(
      Option.isSome(found) && found.value.endsWith(`${gameFiles(game.id).erasedImages}/${name}`),
    );
    assert.isTrue(Option.isNone(yield* play.erasedImage(game.id, `${"0".repeat(64)}.png`)));
    assert.isTrue(Option.isNone(yield* play.erasedImage(game.id, "../catalog.json")));
    const unknown = yield* Effect.flip(play.erasedImage("ffffffffffffffffffff", name));
    assert.strictEqual(unknown._tag, "GameNotInspectedError");
  }).pipe(Effect.provide(services)),
);

it.effect(
  "System.json draws the translated text of read images over their erased backgrounds",
  () =>
    Effect.gen(function* () {
      const play = yield* Play.Play;
      const imageTexts = yield* ImageTexts.ImageTexts;
      const catalogs = yield* Catalogs.Catalogs;
      const game = yield* translatedGame(mvGame);
      const erased = yield* imageTexts.saveErased(game.id, new Uint8Array([1, 2, 3]));
      const box = [0, 0, 40, 16] as const;
      const results: ImageReadResults = {
        version: 1,
        images: {
          "img/pictures/Title": {
            file: "img/pictures/Title.png",
            sha256: "",
            width: 100,
            height: 100,
            lines: [
              {
                text: "标题",
                score: 0.99,
                contrast: 255,
                box,
                polygon: [
                  [0, 0],
                  [40, 0],
                  [40, 16],
                  [0, 16],
                ],
                reader: "paddle",
              },
            ],
            erased,
            blocks: [
              {
                lines: [0],
                grow: 0,
                polygons: [],
                area: box,
                lineHeight: 16,
                space: [0, 0, 100, 30],
                fill: "#ffffff",
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
      yield* imageTexts.save(game.id, results);
      const catalog = yield* catalogs.get(game.id);
      yield* catalogs.save({
        ...catalog,
        entries: [
          ...catalog.entries,
          ...imageEntries(results).map((entry) => ({ ...entry, translation: { user: "Title" } })),
        ],
      });

      const system = JSON.parse(contents(yield* play.file(game.id, "data/System.json")));
      const hint = system.rpgtlImageText["img/pictures/Title"];
      assert.strictEqual(hint.erased, `/erased/${game.id}/${erased}`);
      assert.deepStrictEqual(
        hint.blocks.map((block: { text: string }) => block.text),
        ["Title"],
      );
    }).pipe(Effect.provide(services)),
);
