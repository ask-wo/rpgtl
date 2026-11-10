import { assert, it } from "@effect/vitest";
import type { Entry, GlossaryTerm, TermKind } from "@rpgtl/contracts";
import { characterAliases, glossaryOrder, shortNameTranslations, termTexts } from "./index.ts";

const entries = [
  "美咲：走吧。",
  "美咲：好。",
  "藤原·美咲",
  "菲奥娜来了。",
  "武器",
  "武器店",
  "卡斯特拉",
].map((source, index): Entry => ({
  id: `${index}`,
  file: "Map001.json",
  path: [],
  source,
  translation: {},
}));
const term = (source: string, translation: string, kind: TermKind): GlossaryTerm => ({
  source,
  translation: translation ? { user: translation } : {},
  kind: { guess: { value: kind } },
});

it("the glossary lists new terms, then each kind by use, counting known short names", () => {
  const glossary = [
    term("武器", "Weapon", "word"),
    term("菲奥娜", "Fiona", "character"),
    term("卡斯特拉", "Kastra", "name"),
    term("", "", "word"),
    term("藤原·美咲", "Fujiwara Misaki", "character"),
  ];
  const order = glossaryOrder(glossary, entries).map((index) => glossary[index]?.source);
  assert.deepStrictEqual(order, ["", "藤原·美咲", "菲奥娜", "卡斯特拉", "武器"]);
});

it("a family name two characters share counts for neither, so each counts only its own lines", () => {
  const lines = ["藤原·美咲来了", "藤原·雄一郎来了", "雄一郎：走吧。"].map(
    (source, index): Entry => ({
      id: `${index}`,
      file: "Map001.json",
      path: [],
      source,
      translation: {},
    }),
  );
  const misaki = term("藤原·美咲", "Fujiwara Misaki", "character");
  const yuichiro = term("藤原·雄一郎", "Fujiwara Yuichiro", "character");
  const shortNames = shortNameTranslations([misaki, yuichiro]);
  const aliases = characterAliases([misaki, yuichiro]);
  assert.deepStrictEqual(termTexts(misaki, shortNames, aliases), ["藤原·美咲", "美咲"]);
  assert.deepStrictEqual(termTexts(yuichiro, shortNames, aliases), ["藤原·雄一郎", "雄一郎"]);
  assert.deepStrictEqual(
    glossaryOrder([misaki, yuichiro], lines).map((index) => [misaki, yuichiro][index]?.source),
    ["藤原·雄一郎", "藤原·美咲"],
  );
});
