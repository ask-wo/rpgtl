import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { gameFiles } from "@rpgtl/contracts";
import { writeArchive, xpImageTableFile } from "@rpgtl/domain";
import { command, rubyObject, xpFile, xpMap, xpScripts } from "@rpgtl/domain/testUtils/xpGame";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { strFromU8, unzipSync } from "fflate";
import * as SessionToken from "../auth/SessionToken.ts";
import * as Catalogs from "../games/Catalogs.ts";
import * as StateFolder from "../state/StateFolder.ts";
import { folderWith } from "../testUtils/gameFolder.ts";
import { noPrograms, opened, playServices, servicesWith } from "../testUtils/state.ts";
import { translatedSign } from "../testUtils/xpImages.ts";
import * as XpFixes from "./XpFixes.ts";
import * as XpPatch from "./XpPatch.ts";

const services = XpPatch.layer.pipe(
  Layer.provideMerge(playServices),
  Layer.provideMerge(noPrograms),
  Layer.provideMerge(Layer.succeed(SessionToken.SessionToken, "test-token")),
  Layer.provideMerge(servicesWith({})),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

const map = (text: string) => xpFile(xpMap({ 1: [command(101, text)] }));

/** An XP game whose data and an image are in its archive, which a stale loose map loses to. */
const archivedGame = {
  "Game.rgssad": writeArchive(
    new Map([
      ["Data/System.rxdata", xpFile(rubyObject("RPG::System", {}))],
      ["Data/Map001.rxdata", map("你好")],
      ["Data/Items.rxdata", xpFile([null, rubyObject("RPG::Item", { name: "苔藓" })])],
      ["Data/Scripts.rxdata", xpFile(xpScripts({ Main: "begin_game" }))],
      ["Graphics/Pictures/sign.png", new TextEncoder().encode("sign")],
      ["../outside.txt", new TextEncoder().encode("outside")],
    ]),
  ),
  "Data/Map001.rxdata": map("旧的"),
  "Graphics/Pictures/own.png": "the game's own loose image",
};

const translated = Effect.fnUntraced(function* (files: Record<string, string | Uint8Array>) {
  const catalogs = yield* Catalogs.Catalogs;
  const dir = yield* folderWith(files);
  const { game, catalog } = yield* opened(catalogs.inspect(dir));
  yield* catalogs.save({
    ...catalog,
    translate: false,
    entries: catalog.entries.map((entry) => ({
      ...entry,
      translation: { user: entry.source === "你好" ? "Hello" : "" },
    })),
  });
  return game;
});

it.live("a patch holds the tiles of the translated images and their table, not whole images", () =>
  Effect.gen(function* () {
    const patches = yield* XpPatch.XpPatch;
    const game = yield* translatedSign("Exit");
    const files = Object.keys(unzipSync(yield* patches.zip(game.id, { images: true })));
    assert.include(files, xpImageTableFile);
    assert.lengthOf(
      files.filter((file) => /^Graphics\/RPGTL\/[0-9a-f]{64}\.png$/.test(file)),
      1,
    );
    assert.notInclude(files, "Graphics/Pictures/Sign.png");
    const without = Object.keys(unzipSync(yield* patches.zip(game.id, { images: false })));
    assert.isEmpty(without.filter((file) => file.startsWith("Graphics/")));
  }).pipe(Effect.provide(services)),
);

it.live("a patch holds the translated data files and a readme, whatever the switch says", () =>
  Effect.gen(function* () {
    const patches = yield* XpPatch.XpPatch;
    const game = yield* translated(archivedGame);
    const files = unzipSync(yield* patches.zip(game.id, { images: true }));
    assert.sameMembers(Object.keys(files), [
      "English patch.txt",
      "Data/",
      "Data/Map001.rxdata",
      "Data/Scripts.rxdata",
    ]);
    assert.include(strFromU8(files["Data/Map001.rxdata"] ?? new Uint8Array()), "Hello");
    assert.include(strFromU8(files["English patch.txt"] ?? new Uint8Array()), "Game.rgssad");
  }).pipe(Effect.provide(services)),
);

it.live("a patch's scripts hold the fixes that are on, which its readme names", () =>
  Effect.gen(function* () {
    const patches = yield* XpPatch.XpPatch;
    const xpFixes = yield* XpFixes.XpFixes;
    const catalogs = yield* Catalogs.Catalogs;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const game = yield* translated(archivedGame);
    yield* catalogs.setOriginalScripts(game.id, true);
    const { root } = yield* StateFolder.StateFolder;
    const fixes = path.join(root, gameFiles(game.id).xpFixes);
    yield* fs.makeDirectory(fixes, { recursive: true });
    yield* fs.writeFileString(path.join(fixes, "copy.rb"), "\n# Copies the targets\nclass A; end");
    yield* fs.writeFileString(path.join(fixes, "notes.txt"), "not a fix");
    assert.deepStrictEqual(yield* xpFixes.list(game.id), [
      { name: "copy.rb", description: "Copies the targets", on: true },
    ]);

    const files = unzipSync(yield* patches.zip(game.id, { images: false }));
    assert.include(
      strFromU8(files["Data/Scripts.rxdata"] ?? new Uint8Array()),
      "RPGTL fix copy.rb",
    );
    assert.include(strFromU8(files["English patch.txt"] ?? new Uint8Array()), "- copy.rb");

    assert.deepStrictEqual(yield* xpFixes.set(game.id, "copy.rb", false), [
      { name: "copy.rb", description: "Copies the targets", on: false },
    ]);
    const without = unzipSync(yield* patches.zip(game.id, { images: false }));
    assert.notProperty(without, "Data/Scripts.rxdata");
    assert.notInclude(strFromU8(without["English patch.txt"] ?? new Uint8Array()), "copy.rb");
  }).pipe(Effect.provide(services)),
);

it.live(
  "Unpack writes the archive's files into the game folder and renames it, and undoing it puts the archive and the game's own loose files back",
  () =>
    Effect.gen(function* () {
      const patches = yield* XpPatch.XpPatch;
      const catalogs = yield* Catalogs.Catalogs;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const game = yield* translated(archivedGame);
      const at = (relative: string) => path.join(game.root, relative);
      assert.strictEqual(yield* patches.archive(game.id), "packed");

      assert.strictEqual(yield* patches.unpack(game.id), "unpacked");
      assert.strictEqual(yield* fs.readFileString(at("Graphics/Pictures/sign.png")), "sign");
      assert.deepStrictEqual(yield* fs.readFile(at("Data/Map001.rxdata")), map("你好"));
      assert.isFalse(yield* fs.exists(at("Game.rgssad")));
      assert.isTrue(yield* fs.exists(at("Game.rgssad.original")));
      assert.isFalse(yield* fs.exists(path.join(path.dirname(game.root), "outside.txt")));
      const again = yield* Effect.flip(patches.unpack(game.id));
      assert.strictEqual(again._tag, "ArchiveChangedError");

      // A patch copied over the unpacked files doesn't become the game's own text.
      yield* fs.writeFile(at("Data/Map001.rxdata"), map("Hello"));
      const { catalog } = yield* opened(catalogs.inspect(game.root));
      assert.include(
        catalog.entries.map((entry) => entry.source),
        "你好",
      );

      assert.strictEqual(yield* patches.pack(game.id), "packed");
      assert.isTrue(yield* fs.exists(at("Game.rgssad")));
      assert.deepStrictEqual(yield* fs.readDirectory(at("Data")), ["Map001.rxdata"]);
      assert.deepStrictEqual(yield* fs.readFile(at("Data/Map001.rxdata")), map("旧的"));
      const { root } = yield* StateFolder.StateFolder;
      assert.isFalse(yield* fs.exists(path.join(root, gameFiles(game.id).unpackedOver)));
      assert.isFalse(yield* fs.exists(at("Graphics/Pictures/sign.png")));
      assert.strictEqual(
        yield* fs.readFileString(at("Graphics/Pictures/own.png")),
        "the game's own loose image",
      );
    }).pipe(Effect.provide(services)),
);
