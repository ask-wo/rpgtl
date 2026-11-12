import { assert, it } from "@effect/vitest";
import type { Catalog, Entry } from "@rpgtl/contracts";
import { pickSamples, sampleCatalog } from "./index.ts";

const line = (event: number, index: number, source: string): Entry => ({
  id: `e${event}-${index}`,
  location: {
    _tag: "Message",
    list: { _tag: "MapEventPage", map: 1, event: event, page: 0 },
    index: index,
  },
  source,
  translation: { user: "Done" },
});
const scene = (event: number, sources: ReadonlyArray<string>) =>
  sources.map((source, index) => line(event, index, source));

const catalog: Catalog = {
  version: 1,
  game: { id: "g", title: "雨", engine: "MV" },
  translate: true,
  entries: [
    ...scene(1, ["开门。", "\\n<星澜>你好", "\\n<星澜>走吧"]),
    // Has more speakers than event 1, which repeats its text and is skipped.
    ...scene(2, ["\\n<星澜>你好", "\\n<星澜>走吧", "\\n<星澜>好的"]),
    ...scene(3, ["星澜说她来了。", "\\C[2]星澜\\C[0]笑了。"]),
    ...scene(4, ["星澜说她累了。", "星澜说她饿了。"]),
    {
      id: "attack",
      location: { _tag: "SystemText", keys: ["terms", "commands", "1"] },
      source: "攻击",
      translation: {},
    },
    {
      id: "title",
      location: { _tag: "SystemText", keys: ["gameTitle"] },
      source: "雨",
      translation: {},
    },
    {
      id: "fall",
      location: { _tag: "RecordField", table: "skills", record: 1, field: "message1" },
      source: "\\V[1]倒下了",
      translation: {},
    },
    {
      id: "potion",
      location: { _tag: "RecordField", table: "items", record: 1, field: "description" },
      source: "回复体力。",
      translation: {},
    },
  ],
  glossary: [
    { source: "星澜", translation: { user: "Xinglan" }, kind: { guess: { value: "character" } } },
  ],
};

it("samples take the scenes with the most speakers, menu terms, descriptions and control codes", () => {
  assert.deepStrictEqual(pickSamples(catalog), {
    gameId: "g",
    groups: [
      { label: "Dialogue: map 1 event 2 page 1", ids: ["e2-0", "e2-1", "e2-2"] },
      { label: "Dialogue: map 1 event 3 page 1", ids: ["e3-0", "e3-1"] },
      { label: "Dialogue: map 1 event 4 page 1", ids: ["e4-0", "e4-1"] },
      { label: "Menu terms", ids: ["attack"] },
      { label: "Descriptions", ids: ["potion"] },
      { label: "Control codes", ids: ["fall"] },
    ],
  });
});

const koreanLines = Array.from({ length: 6 }, (_, index) =>
  line(9, index, "오늘은 날씨가 정말 좋구나. 같이 산책하러 갈래?"),
);

it("a sample's entries are untranslated but for fixed ones, with pronouns from the whole game", () => {
  const sample = sampleCatalog(catalog, {
    gameId: "g",
    groups: [{ label: "Descriptions", ids: ["potion", "gone", "attack"] }],
    fixed: { attack: "Attack" },
  });
  assert.deepStrictEqual(sample.entries, [
    {
      id: "attack",
      location: { _tag: "SystemText", keys: ["terms", "commands", "1"] },
      source: "攻击",
      translation: { user: "Attack" },
    },
    {
      id: "potion",
      location: { _tag: "RecordField", table: "items", record: 1, field: "description" },
      source: "回复体力。",
      translation: {},
    },
  ]);
  assert.strictEqual(sample.glossary[0]?.pronoun?.guess?.value, "she");
  // The game's language comes from all of its text, not just the sample's.
  assert.strictEqual(sample.language, "chinese");
  const korean = { ...catalog, entries: [...catalog.entries, ...koreanLines] };
  assert.strictEqual(
    sampleCatalog(korean, { gameId: "g", groups: [{ label: "Menu", ids: ["attack"] }] }).language,
    "korean",
  );
});
