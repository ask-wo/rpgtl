import { assert, it } from "@effect/vitest";
import type { Entry, GlossaryTerm, SourceLanguage } from "@rpgtl/contracts";
import { collectClues, linesAbout } from "./index.ts";

let counter = 0;
const message = (source: string, speaker?: string): Entry => ({
  id: `m${++counter}`,
  location: {
    _tag: "Message",
    list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
    index: counter,
  },
  source: speaker ? `\\n<${speaker}>${source}` : source,
  translation: {},
});
const name = (source: string, translation: string): GlossaryTerm => ({
  source,
  translation: translation ? { user: translation } : {},
  kind: { guess: { value: "character" } },
});
const clues = (
  sources: string[],
  names: string[],
  speaker?: string,
  language: SourceLanguage = "chinese",
) =>
  collectClues(
    sources.map((source) => message(source, speaker)),
    names,
    language,
  );

it("unambiguous short forms of dotted names supply clues and model context", () => {
  const [kentaro, haruna] = ["藤原·雄一郎", "藤原·美咲"] as const;
  const names = [kentaro, haruna];
  const entries = [message("雄一郎说他来"), message("美咲说她来")];
  const found = collectClues(entries, names, "chinese");
  assert.deepStrictEqual(found.get(kentaro), { she: 0, he: 1 });
  assert.deepStrictEqual(found.get(haruna), { she: 1, he: 0 });
  assert.deepStrictEqual(
    linesAbout(
      entries,
      kentaro,
      names.map((source) => name(source, source)),
      "chinese",
    ),
    { lines: ["雄一郎说他来"], count: 1 },
  );
  const ambiguous = collectClues(entries, [...names, "另一家·美咲"], "chinese");
  assert.deepStrictEqual(ambiguous.get(haruna), { she: 0, he: 0 });
  assert.deepStrictEqual(ambiguous.get("另一家·美咲"), { she: 0, he: 0 });
});

it("only the first pronoun after a name counts, unless another name stands in between", () => {
  const names = ["星澜", "林若溪"];
  assert.deepStrictEqual(clues(["星澜说她很累，她走了"], names).get("星澜"), { she: 1, he: 0 });
  assert.deepStrictEqual(clues(["星澜看着林若溪，她笑了"], names).get("星澜"), { she: 0, he: 0 });
  assert.deepStrictEqual(clues(["星澜看着林若溪，她笑了"], names).get("林若溪"), { she: 1, he: 0 });
});

it("a pronoun opening the next sentence belongs to the only name in the sentence before", () => {
  const names = ["星澜", "林若溪"];
  assert.deepStrictEqual(clues(["星澜来了。他很高兴。"], names).get("星澜"), { she: 0, he: 1 });
  assert.deepStrictEqual(clues(["星澜和林若溪来了。她很高兴。"], names).get("星澜"), {
    she: 0,
    he: 0,
  });
  assert.deepStrictEqual(clues(["星澜来了\\!她很高兴"], names).get("星澜"), { she: 1, he: 0 });
});

it("gendered words directly before or after a name are clues", () => {
  const names = ["夏萤", "顾辰"];
  const found = clues(["女警夏萤来了", "夏萤姐在哪", "男孩顾辰", "顾辰哥哥", "夏萤的女警"], names);
  assert.deepStrictEqual(found.get("夏萤"), { she: 2, he: 0 });
  assert.deepStrictEqual(found.get("顾辰"), { she: 0, he: 2 });
});

it("a name's own lines count self-reference once, and speaker tags are not searched", () => {
  const names = ["星澜", "夏萤"];
  assert.deepStrictEqual(clues(["本小姐来了，本小姐不怕"], names, "星澜").get("星澜"), {
    she: 1,
    he: 0,
  });
  assert.deepStrictEqual(clues(["老子来了"], names, "星澜").get("星澜"), { she: 0, he: 1 });
  assert.deepStrictEqual(clues(["本小姐来了"], names, "夏萤").get("星澜"), { she: 0, he: 0 });
  // The speaker tag names the speaker, but only the text after it is searched.
  assert.deepStrictEqual(clues(["她笑了"], names, "星澜").get("星澜"), { she: 0, he: 0 });
});

it("the pronoun question also quotes what the character says", () => {
  const entries = [
    message("本小姐才不怕！", "菲奥娜"),
    message("菲奥娜来了。"),
    message("你好。", "维多利亚"),
  ];
  const glossary = [name("菲奥娜", "Fiona"), name("维多利亚", "Victoria")];
  assert.deepStrictEqual(linesAbout(entries, "菲奥娜", glossary, "chinese"), {
    lines: ["菲奥娜来了", "菲奥娜: 本小姐才不怕"],
    count: 2,
  });
});

it("Korean clues: 그녀 and 그 before a particle, titles after a space, and what a speaker calls others", () => {
  const names = ["김민지", "박준호"];
  const found = clues(
    [
      "김민지는 웃었다. 그녀는 기뻤다.",
      "박준호가 왔다. 그는 지쳤다.",
      "그런데 박준호는 그래도 갔다.",
    ],
    names,
    undefined,
    "korean",
  );
  assert.deepStrictEqual(found.get("김민지"), { she: 1, he: 0 });
  assert.deepStrictEqual(found.get("박준호"), { she: 0, he: 1 });
  const titled = clues(
    ["김민지 언니가 왔어", "박준호 형은 어디 있어?", "박준호오빠!"],
    names,
    undefined,
    "korean",
  );
  assert.deepStrictEqual(titled.get("김민지"), { she: 1, he: 0 });
  assert.deepStrictEqual(titled.get("박준호"), { she: 0, he: 2 });
  assert.deepStrictEqual(clues(["오빠, 같이 가자!"], names, "김민지", "korean").get("김민지"), {
    she: 1,
    he: 0,
  });
  assert.deepStrictEqual(clues(["누나, 기다려!"], names, "박준호", "korean").get("박준호"), {
    she: 0,
    he: 1,
  });
});

it("Japanese clues: 彼女 and 彼 but not 彼ら, titles after a name, and how a speaker says I", () => {
  const names = ["ミサキ", "ハヤト"];
  const found = clues(
    ["ミサキが来た。彼女は笑った。", "ハヤトは彼らを見た。", "ミサキ姉さんはどこ？"],
    names,
    undefined,
    "japanese",
  );
  assert.deepStrictEqual(found.get("ミサキ"), { she: 2, he: 0 });
  assert.deepStrictEqual(found.get("ハヤト"), { she: 0, he: 0 });
  assert.deepStrictEqual(clues(["俺が行く"], names, "ハヤト", "japanese").get("ハヤト"), {
    she: 0,
    he: 1,
  });
  // 他 is other in Japanese.
  assert.deepStrictEqual(
    clues(["ハヤトは他の道を行く"], names, undefined, "japanese").get("ハヤト"),
    {
      she: 0,
      he: 0,
    },
  );
});

it("a name alone on a message's first line is its speaker, not a mention", () => {
  const names = ["ミナ", "ソラ"];
  const entries = [message("ミナ\nあたしが行くよ"), message("ソラ\n彼女はどこ？")];
  const found = collectClues(entries, names, "japanese");
  assert.deepStrictEqual(found.get("ミナ"), { she: 1, he: 0 });
  assert.deepStrictEqual(found.get("ソラ"), { she: 0, he: 0 });
  const glossary = names.map((source) => name(source, source));
  assert.deepStrictEqual(linesAbout(entries, "ミナ", glossary, "japanese"), {
    lines: ["ミナ: あたしが行くよ"],
    count: 1,
  });
  assert.deepStrictEqual(linesAbout(entries, "ソラ", glossary, "japanese"), {
    lines: ["ソラ: 彼女はどこ"],
    count: 1,
  });
});
