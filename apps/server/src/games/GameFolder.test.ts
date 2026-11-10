import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { folderWith, mvGame } from "../testUtils/gameFolder.ts";
import * as GameFolder from "./GameFolder.ts";

const services = GameFolder.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.effect("a game is found in its folder, its www folder, or beside a file in it", () =>
  Effect.gen(function* () {
    const gameFolder = yield* GameFolder.GameFolder;
    const path = yield* Path.Path;
    const root = yield* folderWith(mvGame);
    const webRoot = path.join(root, "www");
    const game = yield* gameFolder.inspect(` ${root} `);
    const { identity, build, ...folder } = game;
    assert.deepStrictEqual(folder, {
      root,
      webRoot,
      engine: "MV",
      title: "雨",
      files: ["Map001.json", "System.json"],
      encryptedAssets: false,
      mediaWarnings: ["movies/Op.mp4 has no .webm counterpart; NW.js cannot play H.264 video."],
      missingImages: [{ path: "img/faces/$Arlene", files: ["Map001.json"] }],
    });
    assert.deepStrictEqual(identity, {});
    assert.match(build?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.match(build?.label ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.deepStrictEqual(yield* gameFolder.inspect(path.join(root, "Game.exe")), game);
    assert.deepStrictEqual(yield* gameFolder.inspect(webRoot), { ...game, root: webRoot });
  }).pipe(Effect.provide(services)),
);

const inFolder = (name: string, files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([file, text]) => [`${name}/${file}`, text]));

it.effect(
  "a game's identity comes from System.json, and its build from its data, plugins and folder name",
  () =>
    Effect.gen(function* () {
      const gameFolder = yield* GameFolder.GameFolder;
      const path = yield* Path.Path;
      const system = {
        gameTitle: "雨",
        versionId: 7,
        encryptionKey: "0f",
        advanced: { gameId: 12345 },
      };
      const dir = yield* folderWith({
        ...inFolder("Rain v0.41", { ...mvGame, "www/data/System.json": JSON.stringify(system) }),
        ...inFolder("Rain Ver1.05", {
          ...mvGame,
          "www/data/System.json": JSON.stringify(system),
          "www/js/plugins.js": "var $plugins = [];",
        }),
      });
      const first = yield* gameFolder.inspect(path.join(dir, "Rain v0.41"));
      const patched = yield* gameFolder.inspect(path.join(dir, "Rain Ver1.05"));
      assert.deepStrictEqual(first.identity, { gameId: 12345, encryptionKey: "0f" });
      assert.deepStrictEqual(
        [first.build?.versionId, first.build?.label, patched.build?.label],
        [7, "v0.41", "Ver1.05"],
      );
      assert.notStrictEqual(first.build?.sha256, patched.build?.sha256);
    }).pipe(Effect.provide(services)),
);

it.effect("no path, a missing one and a folder without a game's core script are refused", () =>
  Effect.gen(function* () {
    const gameFolder = yield* GameFolder.GameFolder;
    const path = yield* Path.Path;
    assert.strictEqual((yield* Effect.flip(gameFolder.inspect(" ")))._tag, "GamePathEmptyError");
    const root = yield* folderWith({});
    const coreless = yield* folderWith({ "index.html": "", "data/System.json": "{}" });
    for (const missing of [path.join(root, "nothing"), coreless]) {
      const error = yield* Effect.flip(gameFolder.inspect(missing));
      assert.strictEqual(error._tag, "NoGameFoundError");
    }
  }).pipe(Effect.provide(services)),
);

it.effect("a game without System.json is an error naming it", () =>
  Effect.gen(function* () {
    const gameFolder = yield* GameFolder.GameFolder;
    const path = yield* Path.Path;
    const { "www/data/System.json": _, ...withoutSystem } = mvGame;
    const root = yield* folderWith(withoutSystem);
    const error = yield* Effect.flip(gameFolder.inspect(root));
    assert.deepInclude(error, {
      _tag: "GameFileMissingError",
      file: path.join(root, "www/data/System.json"),
    });
  }).pipe(Effect.provide(services)),
);

it.effect("an image folder that can't be read is an error, not a missing image", () =>
  Effect.gen(function* () {
    const gameFolder = yield* GameFolder.GameFolder;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* folderWith(mvGame);
    const faces = path.join(root, "www/img/faces/");
    yield* Effect.acquireRelease(fs.chmod(faces, 0o000), () =>
      Effect.orDie(fs.chmod(faces, 0o755)),
    );
    const error = yield* Effect.flip(gameFolder.inspect(root));
    assert.deepInclude(error, { _tag: "GameFileReadError", file: faces });
  }).pipe(Effect.provide(services)),
);

it.effect("a data file that isn't what its name says is an error naming it", () =>
  Effect.gen(function* () {
    const gameFolder = yield* GameFolder.GameFolder;
    const root = yield* folderWith({ ...mvGame, "www/data/Map001.json": '{"events": 5}' });
    const error = yield* Effect.flip(gameFolder.inspect(root));
    assert.deepInclude(error, { _tag: "GameFileInvalid", file: "Map001.json" });
  }).pipe(Effect.provide(services)),
);

it.effect("entries come from the data files and plugin settings that aren't file names", () =>
  Effect.gen(function* () {
    const gameFolder = yield* GameFolder.GameFolder;
    // A plugin's header marks `title` as a file, but RPGTL reads headers only in js/plugins.
    const header = "/*:\n * @param title\n * @type file\n */";
    const root = yield* folderWith({
      ...mvGame,
      "www/js/plugins.js": `var $plugins = ${JSON.stringify([
        { name: "Pic", status: true, parameters: { title: "标题", sound: "合成物品" } },
        { name: "../../../Outside", status: true, parameters: { title: "外面" } },
      ])};`,
      "Outside.js": header,
    });
    const entries = yield* gameFolder.entries(yield* gameFolder.inspect(root));
    assert.deepStrictEqual(
      entries.map((entry) => [entry.file, entry.source]),
      [
        ["Map001.json", "你好"],
        ["System.json", "门开了"],
        ["System.json", "雨"],
        ["plugins.js", "标题"],
        ["plugins.js", "外面"],
      ],
    );
  }).pipe(Effect.provide(services)),
);

it.effect("the game's contents are every data file and the code of the plugins inside it", () =>
  Effect.gen(function* () {
    const gameFolder = yield* GameFolder.GameFolder;
    const root = yield* folderWith({
      ...mvGame,
      "www/js/plugins.js": `var $plugins = ${JSON.stringify([
        { name: "Pic", status: true, parameters: {} },
        { name: "Gone", status: true, parameters: {} },
        { name: "../../../Outside", status: true, parameters: {} },
      ])};`,
      "www/js/plugins/Pic.js": "var pic = 1;",
      "Outside.js": "var outside = 1;",
      "www/data/Notes.json": '{"memo": "备注"}',
    });
    const contents = yield* gameFolder.contents(yield* gameFolder.inspect(root));
    assert.deepStrictEqual(
      contents.dataFiles.map((file) => file.name),
      ["Map001.json", "Notes.json", "System.json"],
    );
    assert.deepStrictEqual([...contents.pluginCode], [["Pic", "var pic = 1;"]]);
  }).pipe(Effect.provide(services)),
);

it.effect("the images to read are the game's own, with the artwork its maps draw signs on", () =>
  Effect.gen(function* () {
    const gameFolder = yield* GameFolder.GameFolder;
    const root = yield* folderWith({
      ...mvGame,
      "www/data/System.json": JSON.stringify({
        gameTitle: "雨",
        hasEncryptedImages: true,
        encryptionKey: "0123456789abcdef0123456789abcdef",
      }),
      "www/data/Map001.json": JSON.stringify({ events: [], parallaxName: "!Town", tilesetId: 1 }),
      "www/data/Tilesets.json": JSON.stringify([
        null,
        { id: 1, tilesetNames: ["A1", "", "", "", "", "Signs", "", "", ""] },
      ]),
      "www/img/pictures/Notice.rpgmvp": "notice",
      "www/img/system/Menu/Button.rpgmvp": "",
      "www/img/characters/Actor.rpgmvp": "",
      "www/img/parallaxes/!Town.rpgmvp": "",
      "www/img/parallaxes/Sky.rpgmvp": "",
      "www/img/tilesets/Signs.rpgmvp": "",
      "www/img/tilesets/Grass.rpgmvp": "",
    });
    const game = yield* gameFolder.inspect(root);
    const { images, key } = yield* gameFolder.textImages(game);
    assert.deepStrictEqual(
      images.map((image) => image.file),
      [
        "img/pictures/Notice.rpgmvp",
        "img/system/Menu/Button.rpgmvp",
        "img/parallaxes/!Town.rpgmvp",
      ],
    );
    assert.strictEqual(images[0]?.image, "img/pictures/Notice");
    assert.deepStrictEqual(key, Option.some("0123456789abcdef0123456789abcdef"));
    assert.strictEqual(
      new TextDecoder().decode(yield* gameFolder.readFile(game, "img/pictures/Notice.rpgmvp")),
      "notice",
    );
    const missing = yield* Effect.flip(gameFolder.readFile(game, "img/pictures/Gone.rpgmvp"));
    assert.strictEqual(missing._tag, "GameFileMissingError");
  }).pipe(Effect.provide(services)),
);

it.effect("a game's file is found in any letter case, and nothing outside its folder is", () =>
  Effect.gen(function* () {
    const gameFolder = yield* GameFolder.GameFolder;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* folderWith({
      ...mvGame,
      "www/img/pictures/title.png": "",
      "secret.txt": "",
    });
    const game = yield* gameFolder.inspect(root);
    yield* fs.symlink(path.join(root, "secret.txt"), path.join(root, "www/img/link.txt"));
    const found = (relative: string) =>
      gameFolder
        .find(game, relative)
        .pipe(Effect.catchTags({ GameFileMissingError: () => Effect.void }));
    const picture = (name: string) => path.join(root, "www/img/pictures", name);
    assert.strictEqual(yield* found("IMG/Pictures/Title.PNG"), picture("Title.png"));
    assert.strictEqual(yield* found("img/pictures/title.png"), picture("title.png"));
    for (const outside of ["../secret.txt", "img/link.txt", "img", "img/none.png"])
      assert.strictEqual(yield* found(outside), undefined, outside);
  }).pipe(Effect.provide(services)),
);
