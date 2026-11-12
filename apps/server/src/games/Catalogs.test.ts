import { gameFiles } from "@rpgtl/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Catalog } from "@rpgtl/contracts";
import type { Entry, ImageReadResults, ImageResult } from "@rpgtl/contracts";
import { imageHash, newEntry, inUse, entryTranslation } from "@rpgtl/domain";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { folderWith, mvGame } from "../testUtils/gameFolder.ts";
import { greyPng, pixelsOf } from "../testUtils/png.ts";
import { game, opened, other, servicesWith, StateDir } from "../testUtils/state.ts";
import * as StateFolder from "../state/StateFolder.ts";
import * as Catalogs from "./Catalogs.ts";
import * as Games from "./Games.ts";

const hello: Entry = {
  id: "a",
  file: "Map001.json",
  path: ["events", "1", "pages", "0", "list", "0", "parameters", "0"],
  source: "你好",
  translation: { user: "Hello 你" },
};
const catalog: Catalog = {
  version: 1,
  game: { id: game.id, title: game.title, engine: "MV" },
  translate: true,
  entries: [hello],
  glossary: [],
};

const servicesOver = (files: Record<string, string>) =>
  servicesWith(files).pipe(Layer.provideMerge(NodeServices.layer));

const backups = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const games = path.join(yield* StateDir, "games");
  if (!(yield* fs.exists(games))) return [];
  const found: Array<string> = [];
  for (const id of yield* fs.readDirectory(games)) {
    const dir = path.join(games, id, "backups");
    if (yield* fs.exists(dir)) found.push(...(yield* fs.readDirectory(dir)));
  }
  return found;
});

it.effect("a game without a catalog file, or a catalog of a game not listed, isn't inspected", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    assert.strictEqual((yield* Effect.flip(catalogs.get(game.id)))._tag, "GameNotInspectedError");
    const unlisted = yield* Effect.flip(catalogs.checks(other.id));
    assert.strictEqual(unlisted._tag, "GameNotInspectedError");
  }).pipe(
    Effect.provide(
      servicesOver({
        "games.json": JSON.stringify([game]),
        [gameFiles(other.id).catalog]: JSON.stringify({
          ...catalog,
          game: { ...catalog.game, id: other.id },
        }),
      }),
    ),
  ),
);

it.effect("saving backs up the catalog it replaces, and the first save backs up nothing", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    yield* catalogs.save(catalog);
    assert.deepStrictEqual(yield* backups, []);
    const edited = {
      ...catalog,
      glossary: [
        {
          source: "雨",
          translation: { user: "Rain" },
          kind: { guess: { value: "name" as const } },
        },
      ],
    };
    yield* catalogs.save(edited);
    assert.strictEqual((yield* backups).length, 1);
    assert.deepStrictEqual(yield* catalogs.get(game.id), edited);
    assert.deepStrictEqual(yield* catalogs.checks(game.id), { a: [{ check: "source text left" }] });
  }).pipe(Effect.provide(servicesOver({ "games.json": JSON.stringify([game]) }))),
);

it.effect("a follower gets the whole catalog, then only the entries each write changes", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const bye: Entry = { ...hello, id: "b", source: "再见", translation: {} };
    yield* catalogs.save({ ...catalog, entries: [hello, bye] });
    const first = yield* Deferred.make<void>();
    const followed = yield* (yield* catalogs.changes(game.id)).pipe(
      Stream.tap(() => Deferred.succeed(first, undefined)),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(first);
    yield* catalogs.write({
      ...catalog,
      entries: [hello, { ...bye, translation: { user: "Bye 再" } }],
    });
    const [whole, changed] = yield* Fiber.join(followed);
    assert.deepStrictEqual(whole, {
      _tag: "whole",
      catalog: { ...catalog, entries: [hello, bye] },
      findings: { a: [{ check: "source text left" }] },
    });
    assert.deepStrictEqual(changed, {
      _tag: "entries",
      catalog: { version: 1, game: catalog.game, translate: true, glossary: [] },
      entries: [{ ...bye, translation: { user: "Bye 再" } }],
      findings: { a: [{ check: "source text left" }], b: [{ check: "source text left" }] },
    });
    assert.deepStrictEqual(yield* catalogs.checks(game.id), {
      a: [{ check: "source text left" }],
      b: [{ check: "source text left" }],
    });
  }).pipe(Effect.provide(servicesOver({ "games.json": JSON.stringify([game]) }))),
);

it.effect("once no one follows a game, the next follower reads its catalog file again", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    yield* catalogs.save(catalog);
    // A request that ends before its stream starts follows nothing.
    const neverRun = yield* catalogs.changes(game.id);
    assert.isDefined(neverRun);
    const first = (yield* catalogs.changes(game.id)).pipe(Stream.take(1), Stream.runCollect);
    yield* first;
    // As a command-line tool in another process writes it.
    const elsewhere = { ...catalog, entries: [{ ...hello, translation: { user: "Hello." } }] };
    yield* (yield* StateFolder.StateFolder).write(gameFiles(game.id).catalog, Catalog, elsewhere);
    const [whole] = yield* (yield* catalogs.changes(game.id)).pipe(
      Stream.take(1),
      Stream.runCollect,
    );
    assert.deepStrictEqual(whole, { _tag: "whole", catalog: elsewhere, findings: {} });
    assert.deepStrictEqual(yield* catalogs.checks(game.id), {});
  }).pipe(Effect.provide(servicesOver({ "games.json": JSON.stringify([game]) }))),
);

const title = (translation: string): Entry => ({
  id: "t",
  file: "System.json",
  path: ["gameTitle"],
  source: "雨",
  translation: translation ? { user: translation } : {},
});

it.effect(
  "the list gives each game's title translation from its saved catalog, following each save",
  () =>
    Effect.gen(function* () {
      const catalogs = yield* Catalogs.Catalogs;
      const titles = Effect.map(catalogs.list, (listed) =>
        listed.map(({ id, titleTranslation }) => [id, titleTranslation]),
      );
      assert.deepStrictEqual(yield* titles, [
        [game.id, undefined],
        [other.id, undefined],
      ]);
      yield* catalogs.save({ ...catalog, entries: [hello, title("Rain Ver 0.2")] });
      assert.deepStrictEqual(yield* titles, [
        [game.id, "Rain"],
        [other.id, undefined],
      ]);
      yield* catalogs.write({ ...catalog, entries: [hello, title("")] });
      assert.deepStrictEqual((yield* titles)[0], [game.id, undefined]);
    }).pipe(Effect.provide(servicesOver({ "games.json": JSON.stringify([game, other]) }))),
);

it.effect("the list marks only the games whose folder no longer holds them", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const { game: found } = yield* opened(catalogs.inspect(yield* folderWith(mvGame), "keepBoth"));
    const listed = yield* catalogs.list;
    assert.deepStrictEqual(
      listed.map(({ id, folderMissing }) => [id, folderMissing]),
      [
        [game.id, true],
        [found.id, undefined],
      ],
    );
  }).pipe(Effect.provide(servicesOver({ "games.json": JSON.stringify([game]) }))),
);

it.effect("the game's language is saved as chosen, and null goes back to the guess", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    yield* catalogs.save(catalog);
    assert.strictEqual((yield* catalogs.setLanguage(game.id, "korean")).language, "korean");
    assert.strictEqual((yield* catalogs.get(game.id)).language, "korean");
    yield* catalogs.setLanguage(game.id, null);
    assert.notProperty(yield* catalogs.get(game.id), "language");
  }).pipe(Effect.provide(servicesOver({ "games.json": JSON.stringify([game]) }))),
);

it.effect("adding terms keeps the glossary's own, and needs the game free", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const games = yield* Games.Games;
    yield* catalogs.save({
      ...catalog,
      glossary: [
        { source: "雨", translation: { user: "Rain" }, kind: { guess: { value: "name" } } },
      ],
    });
    const added = yield* catalogs.addTerms(game.id, [
      { source: "雨", translation: "Drizzle", kind: "name" },
      { source: "星澜", translation: "Xinglan", kind: "character" },
    ]);
    assert.deepStrictEqual(
      added.map((term) => term.source),
      ["星澜"],
    );
    assert.deepStrictEqual(
      (yield* catalogs.get(game.id)).glossary.map((term) => inUse(term.translation)),
      ["Rain", "Xinglan"],
    );
    const busy = yield* Effect.flip(games.exclusive(game.id, catalogs.addTerms(game.id, [])));
    assert.strictEqual(busy._tag, "GameBusyError");
  }).pipe(Effect.provide(servicesOver({ "games.json": JSON.stringify([game]) }))),
);

it.effect(
  "the edited glossary saves without a backup, and clearing mismatches backs up first",
  () =>
    Effect.gen(function* () {
      const catalogs = yield* Catalogs.Catalogs;
      const games = yield* Games.Games;
      const greeting: Entry = {
        ...hello,
        id: "b",
        source: "你好，雨",
        translation: { user: "Hi, Drizzle" },
      };
      yield* catalogs.save({ ...catalog, entries: [hello, greeting] });
      const rain = { source: "雨", translation: "Rain" };
      yield* catalogs.setGlossary(game.id, [rain]);
      assert.deepStrictEqual((yield* catalogs.get(game.id)).glossary, [
        { source: "雨", translation: { user: "Rain" }, kind: { guess: { value: "name" } } },
      ]);
      assert.deepStrictEqual(yield* backups, []);
      const repeated = yield* Effect.flip(catalogs.setGlossary(game.id, [rain, rain]));
      assert.strictEqual(repeated._tag, "GlossaryTermRepeated");

      assert.strictEqual(yield* catalogs.clearTermLines(game.id, ["雨"], true), 1);
      assert.strictEqual((yield* backups).length, 1);
      const cleared = (yield* catalogs.get(game.id)).entries[1];
      assert.deepStrictEqual(cleared, { ...greeting, translation: {}, previous: "Hi, Drizzle" });
      assert.strictEqual(yield* catalogs.clearTermLines(game.id, ["雨"], true), 0);
      assert.strictEqual((yield* backups).length, 1);

      const busy = yield* Effect.flip(games.exclusive(game.id, catalogs.setGlossary(game.id, [])));
      assert.strictEqual(busy._tag, "GameBusyError");
    }).pipe(Effect.provide(servicesOver({ "games.json": JSON.stringify([game]) }))),
);

it.effect(
  "edited English saves without a backup, and not while another operation holds the game",
  () =>
    Effect.gen(function* () {
      const catalogs = yield* Catalogs.Catalogs;
      const games = yield* Games.Games;
      yield* catalogs.save(catalog);
      const before = (yield* backups).length;
      yield* catalogs.setEntries(game.id, [{ id: "a", translation: "Hello" }]);
      assert.deepStrictEqual((yield* catalogs.get(game.id)).entries, [
        { ...hello, translation: { user: "Hello" } },
      ]);
      assert.strictEqual((yield* backups).length, before);
      const busy = yield* Effect.flip(
        games.exclusive(game.id, catalogs.setEntries(game.id, [{ id: "a", translation: "Hi" }])),
      );
      assert.strictEqual(busy._tag, "GameBusyError");
    }).pipe(Effect.provide(servicesOver({ "games.json": JSON.stringify([game]) }))),
);

const noticeImage: ImageResult = {
  file: "Notice.png",
  sha256: "s",
  width: 100,
  height: 40,
  lines: [
    {
      text: "开始",
      box: [10, 10, 40, 30],
      polygon: [
        [10, 10],
        [40, 10],
        [40, 30],
        [10, 30],
      ],
      reader: "paddle",
    },
  ],
};
const notice: ImageReadResults = { version: 1, images: { "img/pictures/Notice": noticeImage } };
const noticeEntry = newEntry("img/pictures/Notice", ["lines", "0"], "开始");

const writeState = Effect.fnUntraced(function* (file: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* StateDir;
  yield* fs.makeDirectory(path.dirname(path.join(dir, file)), { recursive: true });
  yield* fs.writeFileString(path.join(dir, file), text);
});

it.effect(
  "inspecting lists the game and rebuilds its catalog, keeping translations and adding image text",
  () =>
    Effect.gen(function* () {
      const catalogs = yield* Catalogs.Catalogs;
      const games = yield* Games.Games;
      const root = yield* folderWith(mvGame);
      const first = yield* opened(catalogs.inspect(root));
      assert.deepStrictEqual(yield* games.list, [first.game]);
      assert.deepStrictEqual(
        first.catalog.entries.map((entry) => entry.source),
        ["你好", "门开了", "雨", "标题"],
      );
      yield* catalogs.save({
        ...first.catalog,
        entries: first.catalog.entries.map((entry, index) =>
          index === 0 ? { ...entry, translation: { user: "Hello" } } : entry,
        ),
      });
      yield* writeState(gameFiles(first.game.id).imageResults, JSON.stringify(notice));
      const second = yield* opened(catalogs.inspect(root));
      assert.strictEqual(inUse(second.catalog.entries[0]?.translation ?? {}), "Hello");
      assert.deepStrictEqual(second.catalog.entries.at(-1), noticeEntry);
      assert.deepStrictEqual(yield* catalogs.get(first.game.id), second.catalog);
      assert.strictEqual((yield* backups).length, 2);
    }).pipe(Effect.provide(servicesOver({}))),
);

it.effect("opening a removed game's folder again brings it back with its id and translations", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const games = yield* Games.Games;
    const root = yield* folderWith(mvGame);
    const first = yield* opened(catalogs.inspect(root));
    yield* catalogs.save({
      ...first.catalog,
      entries: first.catalog.entries.map((entry, index) =>
        index === 0 ? { ...entry, translation: { user: "Hello" } } : entry,
      ),
    });
    yield* games.forget(first.game.id);
    const again = yield* opened(catalogs.inspect(root));
    assert.strictEqual(again.game.id, first.game.id);
    assert.strictEqual(inUse(again.catalog.entries[0]?.translation ?? {}), "Hello");
    assert.deepStrictEqual(yield* games.list, [again.game]);
  }).pipe(Effect.provide(servicesOver({}))),
);

it.effect("moving a game points it at the new folder, keeping its id, state and place", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const games = yield* Games.Games;
    const first = yield* opened(catalogs.inspect(yield* folderWith(mvGame)));
    const another = { ...mvGame, "www/data/System.json": JSON.stringify({ gameTitle: "雪" }) };
    const second = yield* opened(catalogs.inspect(yield* folderWith(another)));
    yield* catalogs.save({
      ...first.catalog,
      entries: first.catalog.entries.map((entry, index) =>
        index === 0 ? { ...entry, translation: { user: "Hello" } } : entry,
      ),
    });
    yield* writeState(gameFiles(first.game.id).imageResults, JSON.stringify(notice));

    yield* games.forget(second.game.id);
    const taken = yield* Effect.flip(catalogs.move(first.game.id, second.game.root));
    assert.strictEqual(taken._tag, "GameFolderTakenError");
    const unlike = yield* folderWith({
      ...mvGame,
      "www/data/Map001.json": JSON.stringify({ events: [] }),
      "www/js/plugins.js": "var $plugins = [];",
      "www/data/System.json": JSON.stringify({ gameTitle: "雪", switches: ["", "门关了"] }),
    });
    const notSame = yield* Effect.flip(catalogs.move(first.game.id, unlike));
    assert.strictEqual(notSame._tag, "NotSameGameError");

    const third = yield* opened(catalogs.inspect(yield* folderWith(another), "keepBoth"));
    const root = yield* folderWith(mvGame);
    const moved = yield* catalogs.move(first.game.id, root);
    assert.strictEqual(moved.game.id, first.game.id);
    assert.strictEqual(moved.game.root, root);
    assert.deepStrictEqual(yield* games.list, [moved.game, third.game]);
    assert.strictEqual(inUse(moved.catalog.entries[0]?.translation ?? {}), "Hello");
    assert.deepStrictEqual(moved.catalog.entries.at(-1), noticeEntry);
    assert.strictEqual((yield* opened(catalogs.inspect(root))).game.id, first.game.id);
  }).pipe(Effect.provide(servicesOver({}))),
);

/** `mvGame` as an MZ-style game with an id, its one switch named `door`. */
const version = (door: string) => ({
  ...mvGame,
  "www/data/System.json": JSON.stringify({
    gameTitle: "雨",
    switches: ["", door],
    advanced: { gameId: 7 },
  }),
});

it.effect(
  "a new version of a saved game in another folder asks first, and replacing keeps the game's id and the translations of its unchanged lines, after a backup",
  () =>
    Effect.gen(function* () {
      const catalogs = yield* Catalogs.Catalogs;
      const games = yield* Games.Games;
      const first = yield* opened(catalogs.inspect(yield* folderWith(version("门开了"))));
      const kept = first.catalog.entries.find((entry) => entry.source !== "门开了");
      yield* catalogs.save({
        ...first.catalog,
        entries: first.catalog.entries.map((entry) =>
          entry === kept || entry.source === "门开了"
            ? { ...entry, translation: { user: "Hello" } }
            : entry,
        ),
      });
      const before = (yield* backups).length;
      const root = yield* folderWith(version("门关了"));
      const asked = yield* catalogs.inspect(root);
      assert.deepNestedInclude(asked, {
        "otherVersion.game.id": first.game.id,
        "otherVersion.sure": true,
      });
      const refused = yield* Effect.flip(
        catalogs.inspect(root, { replace: "fedcba9876543210fedc" }),
      );
      assert.strictEqual(refused._tag, "GameNotInspectedError");
      const busy = yield* Effect.flip(
        games.exclusive(first.game.id, catalogs.inspect(root, { replace: first.game.id })),
      );
      assert.strictEqual(busy._tag, "GameBusyError");

      const replaced = yield* opened(catalogs.inspect(root, { replace: first.game.id }));
      assert.strictEqual(replaced.game.id, first.game.id);
      assert.strictEqual(replaced.game.root, root);
      const translations = new Map(
        replaced.catalog.entries.map((entry) => [entry.source, entryTranslation(entry)]),
      );
      assert.strictEqual(translations.get(kept?.source ?? ""), "Hello");
      assert.strictEqual(translations.get("门关了"), "");
      assert.deepStrictEqual(yield* games.list, [replaced.game]);
      assert.strictEqual((yield* backups).length, before + 1);

      const separate = yield* opened(
        catalogs.inspect(yield* folderWith(version("门开了")), "keepBoth"),
      );
      assert.notStrictEqual(separate.game.id, first.game.id);
      assert.deepStrictEqual(separate.catalog.entries[0]?.translation, {});
      assert.strictEqual((yield* games.list).length, 2);
    }).pipe(Effect.provide(servicesOver({}))),
);

it.effect("while another operation holds a listed game, inspecting gives its saved catalog", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const games = yield* Games.Games;
    const root = yield* folderWith(mvGame);
    const first = yield* opened(catalogs.inspect(root));
    yield* writeState(gameFiles(first.game.id).imageResults, JSON.stringify(notice));
    assert.deepStrictEqual(
      yield* games.exclusive(first.game.id, opened(catalogs.inspect(root))),
      first,
    );
  }).pipe(Effect.provide(servicesOver({}))),
);

it.effect(
  "an import with image text saves its read results and backgrounds, and drops unused ones, counting the images as it goes",
  () =>
    Effect.gen(function* () {
      const catalogs = yield* Catalogs.Catalogs;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const picture = greyPng(20, 20);
      const { game: inspected, catalog: before } = yield* opened(
        catalogs.inspect(yield* folderWith({ ...mvGame, "www/img/pictures/Notice.png": picture })),
      );
      const erasedDir = path.join(yield* StateDir, gameFiles(inspected.id).erasedImages);
      yield* writeState(`${gameFiles(inspected.id).erasedImages}/old.png`, "old");
      const erased = greyPng(20, 20, [[12, 3]]);
      const read = {
        ...noticeImage,
        file: "img/pictures/Notice.png",
        sha256: imageHash(picture),
      };
      const file = {
        ...before,
        entries: [{ ...noticeEntry, translation: { user: "Begin" } }],
        images: {
          "img/pictures/Notice": {
            ...read,
            erased: [{ x: 0, y: 0, png: greyPng(20, 16, [[12, 3]]) }],
          },
        },
      };
      assert.deepStrictEqual(yield* catalogs.previewImport(inspected.id, file), {
        translations: { inFile: 1, added: 1, changed: 0, cleared: 0, notInGame: 0 },
        glossary: { inFile: 0, added: 0, changed: 0, removed: 0 },
        images: { inFile: 1, replaced: 0 },
      });
      assert.deepStrictEqual(yield* catalogs.get(inspected.id), before);

      const following = yield* Deferred.make<void>();
      const progress = yield* Stream.unwrap(catalogs.importChanges(inspected.id)).pipe(
        Stream.tap(() => Deferred.succeed(following, undefined)),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(following);
      const imported = yield* catalogs.import(inspected.id, file);
      assert.deepStrictEqual(yield* Fiber.join(progress), [
        Option.none(),
        Option.some({ done: 0, total: 1 }),
        Option.none(),
      ]);
      assert.deepStrictEqual(imported.entries.at(-1), {
        ...noticeEntry,
        translation: { user: "Begin" },
      });
      assert.deepStrictEqual(yield* catalogs.get(inspected.id), imported);
      const [name = ""] = yield* fs.readDirectory(erasedDir);
      assert.deepStrictEqual(yield* fs.readDirectory(erasedDir), [name]);
      assert.deepStrictEqual(
        pixelsOf(yield* fs.readFile(path.join(erasedDir, name))),
        pixelsOf(erased),
      );
      const saved = yield* fs.readFileString(
        path.join(yield* StateDir, gameFiles(inspected.id).imageResults),
      );
      assert.deepStrictEqual(JSON.parse(saved), {
        version: 1,
        images: {
          "img/pictures/Notice": { ...read, erased: name },
        },
      });
    }).pipe(Effect.provide(servicesOver({}))),
);

it.effect("an import that doesn't fit the catalog changes nothing", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const error = yield* Effect.flip(
      catalogs.import(game.id, {
        ...catalog,
        entries: [hello, hello],
      }),
    );
    assert.strictEqual(error._tag, "TranslationFileInvalid");
    assert.deepStrictEqual(yield* catalogs.get(game.id), catalog);
    assert.deepStrictEqual(yield* backups, []);
  }).pipe(
    Effect.provide(
      servicesOver({
        "games.json": JSON.stringify([game]),
        [gameFiles(game.id).catalog]: JSON.stringify(catalog),
      }),
    ),
  ),
);
