import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { gameFiles } from "@rpgtl/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as StateFolder from "./StateFolder.ts";
import { stateUpgrades } from "./stateUpgrades.ts";
import { NewerFolderError, upgrade, type Upgrades } from "./upgrade.ts";

const files = gameFiles("0123456789abcdef0123");
const Version = Schema.Struct({ version: Schema.Int });
const Named = Schema.Struct({ name: Schema.String });
const Titled = Schema.Struct({ title: Schema.String });

const toTitles = Effect.fn("toTitles")(function* (folder: StateFolder.StateFolder["Service"]) {
  const catalog = yield* folder.read(files.catalog, Schema.Union([Named, Titled]));
  if (Option.isSome(catalog) && "name" in catalog.value)
    yield* folder.write(files.catalog, Titled, { title: catalog.value.name });
});

const folderWith = Effect.fn("folderWith")(function* (saved: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped();
  const folder = yield* StateFolder.make(dir);
  for (const [file, text] of Object.entries(saved))
    yield* folder.writeBytes(file, new TextEncoder().encode(text));
  const text = (file: string) => fs.readFileString(`${dir}/${file}`);
  return { folder, text };
});

const formatOne = {
  "version.json": '{"version":1}',
  "games.json": "[]",
  [files.catalog]: '{"name":"Moss Lantern"}',
  [`${files.backups}/catalog-1-0.json`]: '{"name":"Moss"}',
  [`${files.logs}/translation-x.log`]: "{}\n",
  [files.samples]: "{}",
};

it.effect("a folder without a format is taken for the latest one and marked with it", () =>
  Effect.gen(function* () {
    const { folder, text } = yield* folderWith({ [files.catalog]: '{"title":"Moss Lantern"}' });
    yield* upgrade(folder, { ...stateUpgrades, steps: [toTitles] });
    assert.deepStrictEqual(
      yield* folder.read("version.json", Version),
      Option.some({ version: 2 }),
    );
    assert.strictEqual(yield* text(files.catalog), '{"title":"Moss Lantern"}');
    assert.deepStrictEqual(yield* folder.list("."), ["games", "version.json"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "an older folder's files are upgraded after a copy, and the files no step reads are set aside",
  () =>
    Effect.gen(function* () {
      const { folder, text } = yield* folderWith(formatOne);
      yield* upgrade(folder, { ...stateUpgrades, steps: [toTitles] });
      assert.deepStrictEqual(
        yield* folder.read(files.catalog, Titled),
        Option.some({ title: "Moss Lantern" }),
      );
      assert.deepStrictEqual(
        yield* folder.read("version.json", Version),
        Option.some({ version: 2 }),
      );
      assert.strictEqual(yield* text(`old/v1/${files.catalog}`), '{"name":"Moss Lantern"}');
      assert.strictEqual(yield* text("old/v1/games.json"), "[]");
      assert.strictEqual(
        yield* text(`old/v1/${files.backups}/catalog-1-0.json`),
        '{"name":"Moss"}',
      );
      assert.strictEqual(yield* text(`old/v1/${files.logs}/translation-x.log`), "{}\n");
      assert.strictEqual(yield* text(`old/v1/${files.samples}`), "{}");
      assert.deepStrictEqual(yield* folder.list(files.folder), ["catalog.json"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a step stopped halfway runs again, and the copy keeps the files from before it", () =>
  Effect.gen(function* () {
    const { folder, text } = yield* folderWith(formatOne);
    const failing: Upgrades["steps"][number] = (inner) =>
      toTitles(inner).pipe(
        Effect.andThen(
          Effect.fail(
            new StateFolder.StateFileError({
              file: files.catalog,
              operation: "write",
              cause: PlatformError.systemError({ _tag: "Busy", module: "test", method: "write" }),
            }),
          ),
        ),
      );
    const stopped = yield* Effect.exit(upgrade(folder, { ...stateUpgrades, steps: [failing] }));
    assert.isTrue(Exit.isFailure(stopped));
    yield* upgrade(folder, { ...stateUpgrades, steps: [toTitles] });
    assert.strictEqual(yield* text(`old/v1/${files.catalog}`), '{"name":"Moss Lantern"}');
    assert.deepStrictEqual(
      yield* folder.read(files.catalog, Titled),
      Option.some({ title: "Moss Lantern" }),
    );
    assert.deepStrictEqual(
      yield* folder.read("version.json", Version),
      Option.some({ version: 2 }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a folder a newer RPGTL saved is refused and left as it is", () =>
  Effect.gen(function* () {
    const { folder, text } = yield* folderWith({ ...formatOne, "version.json": '{"version":3}' });
    const error = yield* Effect.flip(upgrade(folder, { ...stateUpgrades, steps: [toTitles] }));
    assert.deepStrictEqual(
      error,
      new NewerFolderError({ folder: folder.root, version: 3, latest: 2 }),
    );
    assert.strictEqual(yield* text(files.catalog), '{"name":"Moss Lantern"}');
    assert.strictEqual(yield* text("version.json"), '{"version":3}');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
