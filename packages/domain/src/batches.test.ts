import { assert, it } from "@effect/vitest";
import type { Entry } from "@rpgtl/contracts";
import { batchRequest, CatalogDraft, packGroups, sceneBatches, textGroups } from "./index.ts";

const line = (id: string, index: number, list: string): Entry => ({
  id,
  file: "Map001.json",
  path: ["events", list, "pages", "0", "list", String(index), "parameters", "0"],
  source: "你好",
  translation: {},
});

const scene = (list: string, count: number) =>
  Array.from({ length: count }, (_, index) => line(`${list}-${index}`, index, list));

it("short scenes are packed together up to a batch, and a long one goes alone", () => {
  const packed = packGroups([scene("1", 2), scene("2", 2), scene("3", 5), scene("4", 1)], 4);
  assert.deepStrictEqual(
    packed.map((group) => group.map((entry) => entry.id)),
    [["3-0", "3-1", "3-2", "3-3", "3-4"], ["1-0", "1-1", "2-0", "2-1"], ["4-0"]],
  );
});

const button = (file: string, source: string): Entry => ({
  id: file,
  file,
  path: ["lines", "0"],
  source,
  translation: {},
});

it("a menu's button images go to the translator together, each naming its image", () => {
  const entries = [
    button("img/titles1/Command_0", "开始冒险"),
    button("img/titles1/Command_1", "读取存档"),
    button("img/titles1/Commands", "菜单"),
    button("img/pictures/Command_2", "退出"),
  ];
  const groups = textGroups(entries);
  assert.deepStrictEqual(
    groups.map((group) => group.map((entry) => entry.source)),
    [["开始冒险", "读取存档"], ["菜单"], ["退出"]],
  );
  const draft = new CatalogDraft(
    {
      version: 1,
      game: { id: "0123456789abcdef0123", title: "雨", engine: "MV" },
      translate: true,
      entries,
      glossary: [],
    },
    new Map(),
  );
  const menu = (groups[0] ?? []).map((entry) => draft.prepare(entry));
  assert.deepStrictEqual(batchRequest(draft, menu, menu, 10).entries, [
    { id: "1", text: "开始冒险", image: "titles1/Command_0" },
    { id: "2", text: "读取存档", image: "titles1/Command_1" },
  ]);
});

const entriesOf = (length: number) => Array.from({ length }, (_, i) => i);

it("a scene up to its limit goes in one request, and a longer one a batch at a time", () => {
  assert.deepStrictEqual(
    sceneBatches(entriesOf(120), 40, 150).map((b) => b.length),
    [120],
  );
  assert.deepStrictEqual(
    sceneBatches(entriesOf(170), 40, 150).map((b) => b.length),
    [40, 40, 40, 40, 10],
  );
  assert.deepStrictEqual(sceneBatches(entriesOf(0), 40, 150), []);
});
