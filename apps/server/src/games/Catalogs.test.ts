import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type Catalog,
  gameFiles,
  type ImageReadResults,
  type ImageResult,
  type Location,
  type TranslationFile,
} from "@rpgtl/contracts";
import { entryTexts, imageHash, newEntry, withTexts } from "@rpgtl/domain";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Struct from "effect/Struct";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { folderWith, mvGame } from "../testUtils/gameFolder.ts";
import { greyPng, pixelsOf } from "../testUtils/png.ts";
import { game, opened, other, servicesWith, StateDir, storedCatalog } from "../testUtils/state.ts";
import * as Catalogs from "./Catalogs.ts";
import { writeChanged, writeOperation } from "./catalogRows.ts";
import * as GameDatabases from "./GameDatabases.ts";
import * as Games from "./Games.ts";

const message = (index: number): Location => ({
  _tag: "Message",
  list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
  index,
});
const hello = { id: "a", location: message(0), source: "你好", userTranslation: "Hello 你" };

const servicesOver = (files: Record<string, string>) =>
  servicesWith(files).pipe(Layer.provideMerge(NodeServices.layer));
const listed = servicesOver({ "games.json": JSON.stringify([game]) });

it.effect("a game never read, or one not listed, isn't inspected", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    assert.strictEqual((yield* Effect.flip(catalogs.get(game.id)))._tag, "GameNotInspectedError");
    const unlisted = yield* Effect.flip(catalogs.checks(other.id));
    assert.strictEqual(unlisted._tag, "GameNotInspectedError");
  }).pipe(Effect.provide(listed)),
);

it.effect("a follower gets the whole catalog, then only the texts each write changes", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const saved = yield* storedCatalog(game, {
      entries: [hello, { id: "b", location: message(1), source: "再见" }],
    });
    const first = yield* Deferred.make<void>();
    const followed = yield* (yield* catalogs.changes(game.id)).pipe(
      Stream.tap(() => Deferred.succeed(first, undefined)),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(first);
    yield* catalogs.setEntries(game.id, [{ id: "b", userTranslation: "Bye 再" }]);
    const [whole, changed] = yield* Fiber.join(followed);
    assert.deepStrictEqual(whole, {
      _tag: "whole",
      catalog: saved,
      findings: { a: [{ check: "source text left" }] },
    });
    assert.strictEqual(changed?._tag, "texts");
    if (changed?._tag !== "texts") return;
    assert.deepStrictEqual(changed.texts, [
      { id: 2, source: "再见", isInImage: false, userTranslation: "Bye 再" },
    ]);
    const left = [{ check: "source text left" as const }];
    const findings = { a: left, b: left };
    assert.deepStrictEqual(changed.findings, findings);
    assert.deepStrictEqual(yield* catalogs.checks(game.id), findings);
  }).pipe(Effect.provide(listed)),
);

it.effect("once no one follows a game, the next follower reads its database again", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const saved = yield* storedCatalog(game, { entries: [hello] });
    // A request that ends before its stream starts follows nothing.
    const neverRun = yield* catalogs.changes(game.id);
    assert.isDefined(neverRun);
    yield* (yield* catalogs.changes(game.id)).pipe(Stream.take(1), Stream.runCollect);
    // As a command-line tool in another process writes it.
    const elsewhere = withTexts(saved, (text) => ({ ...text, userTranslation: "Hello." }));
    yield* (yield* GameDatabases.GameDatabases)
      .use(
        game.id,
        writeOperation("edit", (operationId) => writeChanged(saved, elsewhere, operationId)),
      )
      .pipe(Effect.orDie);
    const [whole] = yield* (yield* catalogs.changes(game.id)).pipe(
      Stream.take(1),
      Stream.runCollect,
    );
    assert.deepStrictEqual(whole, {
      _tag: "whole",
      catalog: yield* catalogs.get(game.id),
      findings: {},
    });
    assert.deepStrictEqual(yield* catalogs.checks(game.id), {});
  }).pipe(Effect.provide(listed)),
);

it.effect("the list gives each game's title translation, following each write", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const titles = Effect.map(catalogs.list, (all) =>
      all.map(({ id, titleTranslation }) => [id, titleTranslation]),
    );
    assert.deepStrictEqual(yield* titles, [
      [game.id, undefined],
      [other.id, undefined],
    ]);
    yield* storedCatalog(game, {
      entries: [
        hello,
        { id: "t", location: { _tag: "SystemText", keys: ["gameTitle"] }, source: "雨" },
      ],
    });
    assert.deepStrictEqual((yield* titles)[0], [game.id, undefined]);
    yield* catalogs.setEntries(game.id, [{ id: "t", userTranslation: "Rain Ver 0.2" }]);
    assert.deepStrictEqual(yield* titles, [
      [game.id, "Rain"],
      [other.id, undefined],
    ]);
  }).pipe(Effect.provide(servicesOver({ "games.json": JSON.stringify([game, other]) }))),
);

it.effect("the list marks only the games whose folder no longer holds them", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const { game: found } = yield* opened(catalogs.inspect(yield* folderWith(mvGame), "keepBoth"));
    const all = yield* catalogs.list;
    assert.deepStrictEqual(
      all.map(({ id, folderMissing }) => [id, folderMissing]),
      [
        [game.id, true],
        [found.id, undefined],
      ],
    );
  }).pipe(Effect.provide(listed)),
);

it.effect(
  "the game's settings are saved as chosen, and null goes back to the language the text looks like",
  () =>
    Effect.gen(function* () {
      const catalogs = yield* Catalogs.Catalogs;
      yield* storedCatalog(game, { entries: [hello] });
      const korean = yield* catalogs.setLanguage(game.id, "korean");
      assert.strictEqual(korean.settings.sourceLanguage, "korean");
      assert.strictEqual((yield* catalogs.get(game.id)).settings.sourceLanguage, "korean");
      yield* catalogs.setLanguage(game.id, null);
      assert.notProperty((yield* catalogs.get(game.id)).settings, "sourceLanguage");
      yield* catalogs.setFix(game.id, "Fix A", false);
      yield* catalogs.setTranslate(game.id, true);
      const { settings } = yield* catalogs.setScriptTranslation(game.id, false);
      assert.deepNestedInclude(settings, {
        disabledFixes: ["Fix A"],
        isTranslationOn: true,
        isScriptTranslationOn: false,
      });
    }).pipe(Effect.provide(listed)),
);

it.effect(
  "clearing translations clears only English a run gave, and writes nothing when none",
  () =>
    Effect.gen(function* () {
      const catalogs = yield* Catalogs.Catalogs;
      yield* storedCatalog(game, {
        entries: [
          hello,
          { id: "b", location: message(1), source: "嗨", modelTranslation: "Hi" },
          { id: "c", location: message(2), source: "再见" },
        ],
      });
      const ids = ["a", "b", "c"];
      assert.strictEqual(yield* catalogs.clearTranslations(game.id, ids), 1);
      const after = yield* catalogs.get(game.id);
      assert.deepStrictEqual(
        after.texts.map((text) => Struct.omit(text, ["id"])),
        [
          { source: "你好", isInImage: false, userTranslation: "Hello 你" },
          { source: "嗨", isInImage: false, previousTranslation: "Hi" },
          { source: "再见", isInImage: false },
        ],
      );
      assert.strictEqual(yield* catalogs.clearTranslations(game.id, ids), 0);
      assert.strictEqual((yield* catalogs.get(game.id)).operations.length, after.operations.length);
    }).pipe(Effect.provide(listed)),
);

it.effect("the edited glossary saves, and clearing its mismatches clears their texts", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const games = yield* Games.Games;
    yield* storedCatalog(game, {
      entries: [
        hello,
        { id: "b", location: message(1), source: "你好，雨", userTranslation: "Hi, Drizzle" },
      ],
    });
    const rain = { source: "雨", userTranslation: "Rain" };
    yield* catalogs.setGlossary(game.id, [rain]);
    assert.deepStrictEqual(
      (yield* catalogs.get(game.id)).glossary.map(({ source, userTranslation }) => [
        source,
        userTranslation,
      ]),
      [["雨", "Rain"]],
    );
    const repeated = yield* Effect.flip(catalogs.setGlossary(game.id, [rain, rain]));
    assert.strictEqual(repeated._tag, "GlossaryTermRepeated");

    assert.strictEqual(yield* catalogs.clearTermLines(game.id, ["雨"], true), 1);
    const cleared = (yield* catalogs.get(game.id)).texts[1];
    assert.deepStrictEqual(cleared, {
      id: 2,
      source: "你好，雨",
      isInImage: false,
      previousTranslation: "Hi, Drizzle",
    });
    assert.strictEqual(yield* catalogs.clearTermLines(game.id, ["雨"], true), 0);

    const busy = yield* Effect.flip(games.exclusive(game.id, catalogs.setGlossary(game.id, [])));
    assert.strictEqual(busy._tag, "GameBusyError");
  }).pipe(Effect.provide(listed)),
);

it.effect("edited English saves, but not while another operation holds the game", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const games = yield* Games.Games;
    yield* storedCatalog(game, { entries: [hello] });
    yield* catalogs.setEntries(game.id, [{ id: "a", userTranslation: "Hello" }]);
    assert.strictEqual((yield* catalogs.get(game.id)).texts[0]?.userTranslation, "Hello");
    const busy = yield* Effect.flip(
      games.exclusive(game.id, catalogs.setEntries(game.id, [{ id: "a", userTranslation: "Hi" }])),
    );
    assert.strictEqual(busy._tag, "GameBusyError");
  }).pipe(Effect.provide(listed)),
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
const noticeEntry = newEntry(
  { _tag: "ImageLines", image: "img/pictures/Notice", lines: [0] },
  "开始",
);

const writeState = Effect.fnUntraced(function* (file: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* StateDir;
  yield* fs.makeDirectory(path.dirname(path.join(dir, file)), { recursive: true });
  yield* fs.writeFileString(path.join(dir, file), text);
});

/** Gives the game's first entry the user's English. */
const translateFirst = Effect.fnUntraced(function* (id: string) {
  const catalogs = yield* Catalogs.Catalogs;
  const [first] = (yield* catalogs.get(id)).entries;
  if (first) yield* catalogs.setEntries(id, [{ id: first.id, userTranslation: "Hello" }]);
});

const firstTranslation = (catalog: Catalog) => entryTexts(catalog)[0]?.userTranslation;

it.effect(
  "inspecting lists the game and reads its text again, keeping translations and adding image text",
  () =>
    Effect.gen(function* () {
      const catalogs = yield* Catalogs.Catalogs;
      const games = yield* Games.Games;
      const root = yield* folderWith(mvGame);
      const first = yield* opened(catalogs.inspect(root));
      assert.deepStrictEqual(yield* games.list, [first.game]);
      assert.deepStrictEqual(
        entryTexts(first.catalog).map((entry) => entry.source),
        ["你好", "门开了", "雨", "标题"],
      );
      yield* translateFirst(first.game.id);
      yield* writeState(gameFiles(first.game.id).imageResults, JSON.stringify(notice));
      const second = yield* opened(catalogs.inspect(root));
      assert.strictEqual(firstTranslation(second.catalog), "Hello");
      assert.deepNestedInclude(entryTexts(second.catalog).at(-1), {
        id: noticeEntry.id,
        source: "开始",
        isInImage: true,
      });
      assert.deepStrictEqual(yield* catalogs.get(first.game.id), second.catalog);
    }).pipe(Effect.provide(servicesOver({}))),
);

it.effect("opening a removed game's folder again brings it back with its id and translations", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const games = yield* Games.Games;
    const root = yield* folderWith(mvGame);
    const first = yield* opened(catalogs.inspect(root));
    yield* translateFirst(first.game.id);
    yield* games.forget(first.game.id);
    const again = yield* opened(catalogs.inspect(root));
    assert.strictEqual(again.game.id, first.game.id);
    assert.strictEqual(firstTranslation(again.catalog), "Hello");
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
    yield* translateFirst(first.game.id);
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
    assert.strictEqual(firstTranslation(moved.catalog), "Hello");
    assert.strictEqual(moved.catalog.entries.at(-1)?.id, noticeEntry.id);
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
  "a new version of a saved game in another folder asks first, and replacing keeps the game's id and the translations of its unchanged lines",
  () =>
    Effect.gen(function* () {
      const catalogs = yield* Catalogs.Catalogs;
      const games = yield* Games.Games;
      const first = yield* opened(catalogs.inspect(yield* folderWith(version("门开了"))));
      const kept = entryTexts(first.catalog).find((entry) => entry.source !== "门开了");
      yield* catalogs.setEntries(
        first.game.id,
        entryTexts(first.catalog)
          .filter((entry) => entry.id === kept?.id || entry.source === "门开了")
          .map(({ id }) => ({ id, userTranslation: "Hello" })),
      );
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
        entryTexts(replaced.catalog).map((entry) => [entry.source, entry.userTranslation]),
      );
      assert.strictEqual(translations.get(kept?.source ?? ""), "Hello");
      assert.isUndefined(translations.get("门关了"));
      assert.deepStrictEqual(yield* games.list, [replaced.game]);

      const separate = yield* opened(
        catalogs.inspect(yield* folderWith(version("门开了")), "keepBoth"),
      );
      assert.notStrictEqual(separate.game.id, first.game.id);
      assert.isUndefined(firstTranslation(separate.catalog));
      assert.strictEqual((yield* games.list).length, 2);
    }).pipe(Effect.provide(servicesOver({}))),
);

/** `mvGame` titled `gameTitle`, without an MZ game id. */
const build = (gameTitle: string) => ({
  ...mvGame,
  "www/data/System.json": JSON.stringify({ gameTitle, switches: ["", "门开了"] }),
});

it.effect(
  "a deleted game's folder opens as a new game, which asks about a saved game whose title differs only in its last number",
  () =>
    Effect.gen(function* () {
      const catalogs = yield* Catalogs.Catalogs;
      const games = yield* Games.Games;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const first = yield* opened(catalogs.inspect(yield* folderWith(build("雨_TEST12"))));
      const root = yield* folderWith(build("雨_TEST40"));
      const second = yield* opened(catalogs.inspect(root, "keepBoth"));
      const state = path.join(yield* StateDir, gameFiles(second.game.id).folder);
      assert.isTrue(yield* fs.exists(state));

      assert.deepStrictEqual(yield* games.delete(second.game.id), [first.game]);
      assert.isFalse(yield* fs.exists(state));
      assert.deepNestedInclude(yield* catalogs.inspect(root), {
        "otherVersion.game.id": first.game.id,
        "otherVersion.sure": false,
      });
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

const emptyFile: TranslationFile = {
  version: 2,
  texts: [],
  entries: [],
  glossary: [],
  settings: {},
};

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
      const file: TranslationFile = {
        ...emptyFile,
        texts: [{ source: "开始", isInImage: true, userTranslation: "Begin" }],
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
      assert.deepNestedInclude(entryTexts(imported).at(-1), {
        id: noticeEntry.id,
        userTranslation: "Begin",
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
    const saved = yield* storedCatalog(game, { entries: [hello] });
    const error = yield* Effect.flip(
      catalogs.import(game.id, {
        ...emptyFile,
        entries: [{ id: "a" }, { id: "a" }],
      }),
    );
    assert.strictEqual(error._tag, "TranslationFileInvalid");
    assert.deepStrictEqual(yield* catalogs.get(game.id), saved);
  }).pipe(Effect.provide(listed)),
);
