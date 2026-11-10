import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { applyTranslations, decodeGameFile, locationOf, pathOf } from "./index.ts";
import { extractFrom, readGameFile } from "./testUtils/gameFiles.ts";

const commonEvents = [
  null,
  {
    id: 1,
    list: [
      { code: 101, parameters: ["", 0, 0, 2, "勇者"] },
      { code: 401, parameters: ["你好"] },
      { code: 102, parameters: [["是", "否"], 1] },
      { code: 357, parameters: ["Pic", "show", "", { text: "生命值" }] },
      { code: 355, parameters: ['$gameVariables.setValue(5, "人类")'] },
    ],
  },
];
const map = {
  displayName: "大厅",
  note: "<Info:\\C[1]地图>",
  events: [null, { id: 1, name: "客人", note: "<Info:\\C[1]客人>", pages: [] }],
};

it("every path extraction writes reads back as the same location", () => {
  const entries = [
    ...extractFrom("CommonEvents.json", commonEvents),
    ...extractFrom("Map001.json", map),
    ...extractFrom("Classes.json", [
      null,
      { id: 1, name: "剑士", learnings: [{ note: "<A:\\C[1]技>" }] },
    ]),
    ...extractFrom("System.json", { switches: ["", "门"], terms: { commands: ["战斗"] } }),
  ];
  assert.strictEqual(entries.length, 14);
  for (const { file, path } of entries)
    assert.deepStrictEqual(Option.map(locationOf(file, path), pathOf), Option.some(path));
});

it("paths RPGTL never writes have no location", () => {
  assert.isTrue(
    Option.isNone(locationOf("CommonEvents.json", ["1", "list", "x", "parameters", "0"])),
  );
  assert.isTrue(Option.isNone(locationOf("Map001.json", ["events", "1", "pages", "0", "list"])));
  assert.isTrue(Option.isNone(locationOf("Actors.json", ["1"])));
});

it("a data file that isn't what its name says fails naming the file", () => {
  const result = decodeGameFile("Map001.json", JSON.stringify({ events: "none" }));
  assert.isTrue(Result.isFailure(result) && result.failure.file === "Map001.json");
});

it("applying translations leaves the data it was given unchanged", () => {
  const data = readGameFile("CommonEvents.json", commonEvents);
  const before = structuredClone(data);
  const entries = extractFrom("CommonEvents.json", commonEvents).map((entry) => ({
    ...entry,
    translation: { user: `EN ${entry.source}` },
  }));
  assert.isTrue(Result.isSuccess(applyTranslations("CommonEvents.json", data, entries)));
  assert.deepStrictEqual(data, before);
});
