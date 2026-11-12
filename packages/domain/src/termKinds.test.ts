import { assert, it } from "@effect/vitest";
import type { Entry, GlossaryTerm, Location } from "@rpgtl/contracts";
import { termInputs } from "./index.ts";

const entry = (location: Location, source: string, speaker?: string): Entry => ({
  id: JSON.stringify(location),
  location,
  source,
  translation: {},
  ...(speaker && { speaker }),
});
const glossaryTerm = (source: string, extra: Partial<GlossaryTerm> = {}): GlossaryTerm => ({
  source,
  translation: { user: source },
  kind: { guess: { value: "name" } },
  ...extra,
});

const entries = [
  entry({ _tag: "RecordField", table: "actors", record: 1, field: "name" }, "菲奥娜"),
  entry({ _tag: "RecordField", table: "items", record: 3, field: "name" }, "星辉石"),
  entry({ _tag: "MapName", map: 2 }, "巴伦镇"),
  entry(
    {
      _tag: "CommandText",
      list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
      index: 0,
      parameter: 4,
      keys: [],
    },
    "NPC",
  ),
  entry(
    { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 }, index: 1 },
    "你好。",
  ),
  entry(
    { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 2, page: 0 }, index: 1 },
    "\\n<维多利亚>走吧。",
  ),
  entry(
    { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 3, page: 0 }, index: 1 },
    "看，星辉石！",
    "菲奥娜",
  ),
  entry(
    { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 4, page: 0 }, index: 1 },
    "我们去巴伦镇吧。",
  ),
  entry({ _tag: "SystemText", keys: ["terms", "commands", "0"] }, "星辉石"),
];

it("kind questions say where the game uses a term and quote lines that mention it", () => {
  const terms = ["菲奥娜", "星辉石", "巴伦镇", "NPC", "维多利亚", "旅馆"].map((s) =>
    glossaryTerm(s),
  );
  assert.deepStrictEqual(termInputs(entries, terms), [
    { term: "菲奥娜", usedAs: ["actor name", "speaker"], lines: [] },
    { term: "星辉石", usedAs: ["item name", "menu or system term"], lines: ["看，星辉石！"] },
    { term: "巴伦镇", usedAs: ["map name"], lines: ["我们去巴伦镇吧。"] },
    { term: "NPC", usedAs: ["speaker"], lines: [] },
    { term: "维多利亚", usedAs: ["speaker"], lines: [] },
    { term: "旅馆", usedAs: [], lines: [] },
  ]);
});
