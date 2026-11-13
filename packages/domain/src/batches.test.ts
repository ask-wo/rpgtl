import { assert, it } from "@effect/vitest";
import type { Entry } from "@rpgtl/contracts";
import { batchRequest, CatalogDraft, packGroups, textGroups } from "./index.ts";

const line = (id: string, index: number, list: number): Entry => ({
  id,
  location: {
    _tag: "Message",
    list: { _tag: "MapEventPage", map: 1, event: list, page: 0 },
    index: index,
  },
  source: "你好",
  translation: {},
});

const scene = (list: number, count: number) =>
  Array.from({ length: count }, (_, index) => line(`${list}-${index}`, index, list));

it("short scenes are packed together up to a batch, and a long one goes alone", () => {
  const packed = packGroups([scene(1, 2), scene(2, 2), scene(3, 5), scene(4, 1)], 4);
  assert.deepStrictEqual(
    packed.map((group) => group.map((entry) => entry.id)),
    [["3-0", "3-1", "3-2", "3-3", "3-4"], ["1-0", "1-1", "2-0", "2-1"], ["4-0"]],
  );
});

const button = (file: string, source: string): Entry => ({
  id: file,
  location: { _tag: "ImageLines", image: file, lines: [0] },
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
  const groups = textGroups(entries, 40);
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

const description = (record: number): Entry => ({
  id: `skill-${record}`,
  location: { _tag: "RecordField", table: "skills", record, field: "description" },
  source: "火を放つ。",
  translation: {},
});

it("a long table goes a batch at a time side by side, while an event list stays whole in order", () => {
  const groups = textGroups(
    [...Array.from({ length: 5 }, (_, record) => description(record + 1)), ...scene(1, 5)],
    2,
  );
  assert.deepStrictEqual(
    groups.map((group) => group.length),
    [2, 2, 1, 5],
  );
});
