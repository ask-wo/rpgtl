import { translationChecks } from "./index.ts";
import { assert, it } from "@effect/vitest";
import type { GlossaryTerm } from "@rpgtl/contracts";

const glossary: GlossaryTerm[] = [
  {
    source: "老师",
    translation: { user: "Teacher" },
    kind: { guess: { value: "word", run: "r" } },
  },
  {
    source: "装备",
    translation: { user: "Equipment" },
    kind: { guess: { value: "word", run: "r" } },
  },
  { source: "小葵", translation: { user: "Aoi" }, kind: { guess: { value: "word" } } },
  { source: "林若溪", translation: { user: "Lin Ruoxi" }, kind: { guess: { value: "character" } } },
  { source: "变身", translation: { user: "Transform" }, kind: { guess: { value: "name" } } },
  { source: "月", translation: { user: "Yue" }, kind: { guess: { value: "character" } } },
  { source: "토키", translation: { user: "Toki" }, kind: { guess: { value: "character" } } },
];
const check = translationChecks(glossary, "chinese");
const line = (source: string, translation: string) =>
  check(
    {
      file: "Map001.json",
      path: ["events", "1", "pages", "0", "list", "0"],
      source,
    },
    translation,
  ).map((finding) => finding.check);

it("A glossary word counts as capitalised mid-sentence only after a lowercase word or a possessive", () => {
  assert.deepStrictEqual(line("我们去问老师吧", "We should go ask the Teacher."), [
    "glossary word capitalised mid-sentence",
  ]);
  assert.deepStrictEqual(line("老师的书", "Her Teacher's book."), [
    "glossary word capitalised mid-sentence",
  ]);
  assert.deepStrictEqual(line("老师，早上好", "Teacher, good morning."), []);
  assert.deepStrictEqual(line("【普通装备】亚麻服装。", "[Common Equipment] Linen clothing."), []);
  assert.deepStrictEqual(line("和老师初遇", "First Encounter with the Teacher"), []);
  // A term the model hasn't sorted may be a name.
  assert.deepStrictEqual(line("我和小葵聊了聊", "I chatted with Aoi."), []);
});

it("A glossary name counts as missing only when no part or form of it is in the English", () => {
  assert.deepStrictEqual(line("林若溪笑了。", "Ruoxi smiled."), []);
  assert.deepStrictEqual(line("林若溪又变身了！", "Lin Ruoxi is transforming again!"), []);
  assert.deepStrictEqual(line("林若溪又变身了！", "Xinglan is transforming again!"), [
    "glossary name missing",
  ]);
  assert.deepStrictEqual(line("这个月很忙。", "This month is busy."), []);
  assert.deepStrictEqual(line("토키가 웃었다.", "She smiled."), ["glossary name missing"]);
  assert.deepStrictEqual(line("블랙토키가 웃었다.", "Black Toque smiled."), []);
});

it("Pronouns count as unlike the source only against a lone 她 or 他", () => {
  assert.deepStrictEqual(line("她笑了。", "He smiled."), ["pronoun unlike the source"]);
  assert.deepStrictEqual(line("他笑了。", "She smiled."), ["pronoun unlike the source"]);
  assert.deepStrictEqual(line("她和他笑了。", "He smiled."), []);
  assert.deepStrictEqual(line("她不想让他们走。", "She doesn't want them to leave."), []);
  assert.deepStrictEqual(line("她看着其他人。", "He watched the others."), [
    "pronoun unlike the source",
  ]);
  assert.deepStrictEqual(line("他们看着她。", "They watched her."), []);
});

it("In a Japanese game, 他 means other, not he", () => {
  const japanese = translationChecks(glossary, "japanese");
  const findings = japanese(
    {
      file: "Map001.json",
      path: ["events", "1", "pages", "0", "list", "0"],
      source: "他の店へ行こうか。",
    },
    "Shall she try another shop?",
  );
  assert.deepStrictEqual(findings, []);
});

it("Credits keep their names, and dialogue may apologize", () => {
  assert.deepStrictEqual(line("画师:青木流水", "Artist: 青木流水"), []);
  assert.deepStrictEqual(line("坏的预感。", "the bad预感"), ["source text left"]);
  assert.deepStrictEqual(line("「ァ」の字", 'the letter "ァ"'), []);
  assert.deepStrictEqual(line("〇/✕", "〇/✕"), []);
  assert.deepStrictEqual(line("抱歉，我没办法。", "I'm sorry, but I can't help it."), []);
  assert.deepStrictEqual(line("你好", "I'm sorry, but I can't assist with that."), ["refusal"]);
});

it("Korean or kana left in the English is flagged, and a Korean line answered with a name alone is unlike it", () => {
  assert.deepStrictEqual(line("오늘은 비가 와요.", "Today 비가 falls."), ["source text left"]);
  assert.deepStrictEqual(line("하루는 오늘 시장에 가서 사과를 샀어요.", "Haru."), [
    "length unlike the source",
  ]);
  assert.deepStrictEqual(
    line("하루는 오늘 시장에 가서 사과를 샀어요.", "Haru went to the market and bought apples."),
    [],
  );
  assert.deepStrictEqual(line("そうですか、わかりました。", "I see, got it."), []);
});
