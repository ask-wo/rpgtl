import { assert, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { applyTranslations, decodeGameFile, mapOf, newEntry } from "../../index.ts";
import { extractFrom, readGameFile } from "../../testUtils/gameFiles.ts";

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
it("only a map file named as the engine loads it holds a map", () => {
  assert.strictEqual(mapOf("Map007.json"), 7);
  assert.strictEqual(mapOf("Map1000.json"), 1000);
  assert.isUndefined(mapOf("Map7.json"));
  assert.isUndefined(mapOf("MapInfos.json"));
  assert.isTrue(readGameFile("Map7.json", { events: [] })._tag === "Other");
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

it("an entry's id hashes the map file, keys and text, so ids saved by earlier versions still match", () => {
  const list = { _tag: "MapEventPage", map: 1, event: 2, page: 0 } as const;
  assert.strictEqual(
    newEntry({ _tag: "Message", list, index: 3 }, "你好").id,
    "5716ee84582b19e0c8a93b8d",
  );
  assert.strictEqual(
    newEntry({ _tag: "EventName", map: 1, event: 2 }, "客人").id,
    "8e5c325f0fdfee418b0aea67",
  );
});
