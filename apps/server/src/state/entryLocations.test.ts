import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { Location } from "@rpgtl/contracts";
import { decodeGameFile, extract, extractPlugins, fileOf, pathOf } from "@rpgtl/domain";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { locationFrom } from "./entryLocations.ts";
import * as StateFolder from "./StateFolder.ts";

const list = (code: number, parameters: ReadonlyArray<unknown>) => ({ code, parameters });
const commands = [
  list(101, ["", 0, 0, 2, "勇者"]),
  list(401, ["你好"]),
  list(102, [["是", "否"], 1]),
  list(357, ["Pic", "show", "", { text: "生命值" }]),
  list(355, ['$gameVariables.setValue(5, "人类")']),
];
const files: Record<string, unknown> = {
  "CommonEvents.json": [null, { id: 1, list: commands }],
  "Troops.json": [null, { id: 1, pages: [{ list: commands }] }],
  "Map012.json": {
    displayName: "大厅",
    note: "<Info:\\C[1]地图>",
    events: [null, { id: 1, name: "客人", note: "<Info:\\C[1]客人>", pages: [{ list: commands }] }],
  },
  "Classes.json": [
    null,
    { id: 1, name: "剑士", note: "<Info:\\C[1]职业>", learnings: [{ note: "<A:\\C[1]技>" }] },
  ],
  "Tilesets.json": [null, { id: 1, name: "草原", note: "<Info:\\C[1]地块>" }],
  "System.json": { gameTitle: "雨", switches: ["", "门"], terms: { commands: ["战斗"] } },
};

it("every location extraction makes reads back from the file and path format 1 saved", () => {
  const locations: Array<Location> = [
    ...Object.entries(files).flatMap(([file, data]) =>
      extract(Result.getOrThrow(decodeGameFile(file, JSON.stringify(data)))),
    ),
    ...extractPlugins([{ name: "Menu", status: true, parameters: { Title: "菜单" } }], {
      nonText: () => new Set(),
      fileNames: new Set(),
    }),
  ].map((entry) => entry.location);
  locations.push({ _tag: "ImageLines", image: "img/pictures/Sign", lines: [0, 2] });
  assert.deepStrictEqual(
    new Set(locations.map((location) => location._tag)).size,
    11,
    "each kind of location",
  );
  for (const location of locations)
    assert.deepStrictEqual(locationFrom(fileOf(location), pathOf(location)), location);
});

it("a path format 1 never saved names no location", () => {
  assert.isUndefined(locationFrom("CommonEvents.json", ["1", "list", "x", "parameters", "0"]));
  assert.isUndefined(locationFrom("Map001.json", ["events", "1", "pages", "0", "list"]));
  assert.isUndefined(locationFrom("Map1.json", ["displayName"]));
  assert.isUndefined(locationFrom("Actors.json", ["1"]));
});

it.effect("upgrading format 1's catalog gives format 2's", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const formats = new URL("formats", import.meta.url).pathname;
    const catalog = "games/4d6f73734c616e746572/catalog.json";
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.copy(path.join(formats, "1", "state"), dir);
    yield* Effect.provide(Effect.asVoid(StateFolder.StateFolder), StateFolder.layerAt(dir));
    const read = (file: string) => Effect.map(fs.readFileString(file), JSON.parse);
    assert.deepStrictEqual(
      yield* read(path.join(dir, catalog)),
      yield* read(path.join(formats, "2", "state", catalog)),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
