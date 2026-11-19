import { glossaryFindings, sourceLeft, translationChecks } from "./index.ts";
import { assert, it } from "@effect/vitest";
import { testTerm } from "./testUtils/catalog.ts";

const glossary = [
  testTerm("老师", { userTranslation: "Teacher", modelKind: "word" }),
  testTerm("装备", { userTranslation: "Equipment", modelKind: "word" }),
  testTerm("小葵", { userTranslation: "Aoi", rulesKind: "word" }),
  testTerm("林若溪", { userTranslation: "Lin Ruoxi", rulesKind: "character" }),
  testTerm("变身", { userTranslation: "Transform", rulesKind: "name" }),
  testTerm("月", { userTranslation: "Yue", rulesKind: "character" }),
  testTerm("토키", { userTranslation: "Toki", rulesKind: "character" }),
];
const check = translationChecks(glossary, "chinese", "MV");
const line = (source: string, translation: string) =>
  check(
    {
      location: {
        _tag: "Message",
        list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
        index: 0,
      },
      source,
    },
    translation,
  ).map((finding) => finding.check);

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
  const japanese = translationChecks(glossary, "japanese", "MV");
  const findings = japanese(
    {
      location: {
        _tag: "Message",
        list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
        index: 0,
      },
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

it("an English that lost or added a bare | of the source is flagged, but not a `\\|` code", () => {
  assert.deepStrictEqual(line("第一行|第二行", "First row\nSecond row"), ["| unlike the source"]);
  assert.deepStrictEqual(line("稍候片刻\\|启程吧", "One moment\\| onward we ride"), []);
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

it("An XP name's tags may keep the source's text, which an MV name's brackets may not", () => {
  const name = {
    location: { _tag: "RecordField", table: "skills", record: 2, field: "name" },
    source: "火花{テスト用}",
  } as const;
  assert.deepStrictEqual(
    translationChecks(glossary, "japanese", "XP")(name, "Spark{テスト用}"),
    [],
  );
  assert.deepStrictEqual(translationChecks(glossary, "japanese", "MV")(name, "Spark{テスト用}"), [
    { check: "source text left" },
  ]);
});

it("The ミ of a shooting star ★ミ may stay", () => {
  assert.isFalse(sourceLeft("流れ星キック★ミ", "Shooting Star Kick★ミ"));
  assert.isTrue(sourceLeft("流れ星キックミ", "Shooting Star Kickミ"));
});

const name = (source: string, english: string) =>
  testTerm(source, { userTranslation: english, rulesKind: "name" });

it("a term whose English leaves out a name inside it is flagged, though a character may go by part of their name", () => {
  const found = glossaryFindings([
    ...glossary,
    name("卡洛", "Carlo"),
    name("卡洛湖", "Lake Carlo"),
    name("卡洛之雨", "Karlo's Rain"),
    name("卡洛湖西", "West Carlo Lake"),
    name("卡洛湖岸", "Shore of Lake Carlo"),
    name("林若溪的伞", "Ruoxi's Umbrella"),
    name("卡洛湖$q", "Lake Carlo$q"),
    name("冰封的$q卡洛湖$q", "Glacial$qLake Carlo$q"),
    name("ベガ", "Vega"),
    name("オベガ", "Overga"),
    name("ベガラ", "Vegara"),
  ]);
  assert.deepStrictEqual(Object.fromEntries(found), {
    卡洛之雨: ["卡洛 → Carlo"],
    卡洛湖西: ["卡洛湖 → Lake Carlo"],
  });
});

it("a plural right after a number the game fills in is flagged, since it reads wrong at 1", () => {
  const source = "码头上亮着\\V[3]盏灯笼。";
  assert.deepStrictEqual(line(source, "\\V[3] lanterns glow on the pier."), [
    "plural after a number",
  ]);
  assert.deepStrictEqual(line(source, "Only \\C[2]\\V[3]\\C[0] more lanterns glow."), [
    "plural after a number",
  ]);
  assert.deepStrictEqual(line(source, "Lanterns lit: \\V[3]"), []);
  assert.deepStrictEqual(line(source, "\\V[3] is plenty."), []);
  // The next label of a stat list whose lines the English joined.
  assert.deepStrictEqual(
    line("灯笼：\\V[3]\n步数：\\V[4]", "Lanterns: \\V[3] Steps left: \\V[4]"),
    [],
  );
});

const script = (source: string, code: string, translation: string) =>
  check(
    { location: { _tag: "RubyScriptText", script: 1, name: "Shop", literal: 2 }, source, code },
    translation,
  ).map((finding) => finding.check);

it("a script string appended right after a value is flagged when its English starts with a letter, since the two run together", () => {
  const afterName = 'msg = "\\C[6]" + item.name + "\\C[0]"\nmsg += "を拾い上げた！"';
  assert.deepStrictEqual(script("を拾い上げた！", afterName, "Picked up!"), [
    "no space after a value",
  ]);
  assert.deepStrictEqual(script("を拾い上げた！", afterName, " was picked up!"), []);
  assert.deepStrictEqual(script("なし", 'msg = "所持品："\nmsg += "なし"', "None"), []);
});
