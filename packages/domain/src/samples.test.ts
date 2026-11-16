import { assert, it } from "@effect/vitest";
import { entryTexts, pickSamples, sampleCatalog } from "./index.ts";
import { testCatalog, testTerm } from "./testUtils/catalog.ts";

const line = (event: number, index: number, source: string) => ({
  id: `e${event}-${index}`,
  location: {
    _tag: "Message" as const,
    list: { _tag: "MapEventPage" as const, map: 1, event: event, page: 0 },
    index: index,
  },
  source,
  userTranslation: "Done",
});
const scene = (event: number, sources: ReadonlyArray<string>) =>
  sources.map((source, index) => line(event, index, source));

const attack = {
  id: "attack",
  location: { _tag: "SystemText", keys: ["terms", "commands", "1"] },
  source: "攻击",
} as const;
const potion = {
  id: "potion",
  location: { _tag: "RecordField", table: "items", record: 1, field: "description" },
  source: "回复体力。",
} as const;
const entries = [
  ...scene(1, ["开门。", "\\n<星澜>你好", "\\n<星澜>走吧"]),
  // Has more speakers than event 1, which repeats its text and is skipped.
  ...scene(2, ["\\n<星澜>你好", "\\n<星澜>走吧", "\\n<星澜>好的"]),
  ...scene(3, ["星澜说她来了。", "\\C[2]星澜\\C[0]笑了。"]),
  ...scene(4, ["星澜说她累了。", "星澜说她饿了。"]),
  attack,
  { id: "title", location: { _tag: "SystemText", keys: ["gameTitle"] }, source: "雨" } as const,
  {
    id: "fall",
    location: { _tag: "RecordField", table: "skills", record: 1, field: "message1" },
    source: "\\V[1]倒下了",
  } as const,
  potion,
];
const glossary = [testTerm("星澜", { userTranslation: "Xinglan", rulesKind: "character" })];
const catalog = testCatalog({ entries, glossary });

it("samples take the scenes with the most speakers, menu terms, descriptions and control codes", () => {
  assert.deepStrictEqual(pickSamples(catalog), {
    gameId: "test-game",
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
  line(9, index, `오늘은 날씨가 정말 좋구나. 같이 산책하러 갈래? ${index}`),
);

it("a sample's entries are untranslated but for fixed ones, with pronouns from the whole game", () => {
  const sample = sampleCatalog(catalog, {
    gameId: "test-game",
    groups: [{ label: "Descriptions", ids: ["potion", "gone", "attack"] }],
    fixed: { attack: "Attack" },
  });
  assert.deepStrictEqual(entryTexts(sample), [
    {
      ...attack,
      textId: 1 + catalog.texts.findIndex((text) => text.source === "攻击"),
      isInImage: false,
      userTranslation: "Attack",
    },
    {
      ...potion,
      textId: 1 + catalog.texts.findIndex((text) => text.source === "回复体力。"),
      isInImage: false,
    },
  ]);
  assert.strictEqual(sample.glossary[0]?.rulesPronoun, "she");
  // The game's language comes from all of its text, not just the sample's.
  assert.strictEqual(sample.settings.sourceLanguage, "chinese");
  const korean = testCatalog({ entries: [...entries, ...koreanLines], glossary });
  assert.strictEqual(
    sampleCatalog(korean, { gameId: "test-game", groups: [{ label: "Menu", ids: ["attack"] }] })
      .settings.sourceLanguage,
    "korean",
  );
});
