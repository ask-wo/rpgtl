import { assert, it } from "@effect/vitest";
import type { Text } from "@rpgtl/contracts";
import {
  givenNameTranslation,
  shortNameTranslation,
  shortNameTranslations,
  textsToClear,
} from "./index.ts";
import { testEntry, testTerm } from "./testUtils/catalog.ts";

let counter = 0;
const message = (source: string): Text => ({ id: ++counter, source, isInImage: false });
const name = (source: string, translation: string) =>
  testTerm(source, { userTranslation: translation, rulesKind: "character" });

it("the short form of a dotted name takes the last word of its translation", () => {
  assert.strictEqual(shortNameTranslation("藤原·美咲", "Fujiwara Misaki"), "Misaki");
  assert.strictEqual(shortNameTranslation("魔法少女·美咲", "Magical Girl Misaki"), "Misaki");
  assert.isUndefined(shortNameTranslation("藤原·美咲", "Misaki"));
  assert.isUndefined(shortNameTranslation("美咲", "Misaki"));
});

const mapLine = (source: string) =>
  testEntry(
    {
      _tag: "CommandText",
      list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
      index: 0,
      parameter: 0,
      keys: ["0"],
    },
    source,
  );

it("the given name of a dotted name is the part the text uses on its own most", () => {
  const text = [mapLine("艾琳娜·莫顿来了。"), mapLine("艾琳娜，你好。"), mapLine("莫顿家的人")];
  assert.strictEqual(
    givenNameTranslation("艾琳娜·莫顿", "Irena Morton", [...text, mapLine("艾琳娜？")]),
    "Irena",
  );
  assert.strictEqual(givenNameTranslation("藤原·美咲", "Fujiwara Misaki", []), "Misaki");
  assert.strictEqual(
    givenNameTranslation("魔法少女·美咲", "Magical Girl Misaki", [mapLine("魔法少女来了")]),
    "Misaki",
  );
  assert.isUndefined(givenNameTranslation("美咲", "Misaki", text));
});

it("short-name translations require agreement unless an explicit term overrides them", () => {
  const haruna = name("藤原·美咲", "Fujiwara Misaki");
  const magical = name("魔法少女·美咲", "Magical Girl Misaki");
  assert.strictEqual(shortNameTranslations([haruna, magical]).get("美咲"), "Misaki");
  const conflicting = name("西园·美咲", "Saionji Chunna");
  assert.strictEqual(shortNameTranslations([haruna, conflicting]).has("美咲"), false);
  assert.strictEqual(
    shortNameTranslations([haruna, name("西园·美咲", "Misaki")]).has("美咲"),
    false,
  );
  assert.strictEqual(
    shortNameTranslations([haruna, conflicting, name("美咲", "Haru")]).get("美咲"),
    "Haru",
  );
});

it("a part of a dotted name takes the word in its place when the counts match", () => {
  const cecile = name("艾琳娜·莫顿", "Irena Morton");
  const shorts = shortNameTranslations([cecile, name("艾琳娜·莫顿未知", "Irena Morton Unknown")]);
  assert.strictEqual(shorts.get("艾琳娜"), "Irena");
  assert.strictEqual(shorts.get("莫顿"), "Morton");
  // 魔法少女 is only a guess by place, and a guess that disagrees blocks.
  const magical = name("魔法少女·美咲", "Magical Girl Misaki");
  assert.strictEqual(shortNameTranslations([magical]).has("魔法少女"), false);
  assert.strictEqual(
    shortNameTranslations([cecile, name("艾琳娜·莫顿·二世", "Irina Morton II Junior")]).has(
      "艾琳娜",
    ),
    false,
  );
  const texts = [
    { ...message("艾琳娜姐说得对"), userTranslation: "Cecyru-nee is right" },
    { ...message("艾琳娜姐来了"), userTranslation: "Irena-nee is here" },
  ];
  assert.deepStrictEqual(textsToClear({ texts, glossary: [cecile] }, cecile, true), [texts[0]]);
});

it("clearing mismatches keeps a line that uses the English, whatever its pronouns", () => {
  const misaki = { ...name("藤原·美咲", "Fujiwara Misaki"), userPronoun: "she" as const };
  const text = {
    ...message("藤原·美咲来了"),
    userTranslation: "Fujiwara Misaki gave him the key",
  };
  assert.deepStrictEqual(textsToClear({ texts: [text], glossary: [misaki] }, misaki, true), []);
});

it("clearing a dotted name's mismatches also finds lines that use its short form", () => {
  const haruna = name("藤原·美咲", "Fujiwara Misaki");
  const texts = [
    { ...message("美咲，你好"), userTranslation: "Chunai, hello" },
    { ...message("美咲来了"), userTranslation: "Misaki is here" },
    { ...message("藤原·美咲来了"), userTranslation: "Misaki is here" },
    { ...message("藤原·美咲走了"), userTranslation: "Fujiwara Misaki left" },
  ];
  const glossary = [haruna, name("藤原·雄一郎", "Fujiwara Yuichiro")];
  assert.deepStrictEqual(textsToClear({ texts, glossary }, haruna, true), [texts[0], texts[2]]);
  assert.deepStrictEqual(textsToClear({ texts, glossary }, haruna, false), texts);
  const twins = [haruna, name("西园·美咲", "Saionji Misaki")];
  assert.deepStrictEqual(textsToClear({ texts, glossary: twins }, haruna, true), [
    texts[0],
    texts[2],
  ]);
  const conflicting = [haruna, name("西园·美咲", "Saionji Chunna")];
  assert.deepStrictEqual(textsToClear({ texts, glossary: conflicting }, haruna, true), [texts[2]]);
  const explicit = [...conflicting, name("美咲", "Hana")];
  assert.deepStrictEqual(
    textsToClear({ texts, glossary: explicit }, haruna, true),
    texts.slice(0, 3),
  );
});

it("clearing all of a character's lines leaves the lines of another with the same family name", () => {
  const misaki = name("藤原·美咲", "Fujiwara Misaki");
  const yuichiro = name("藤原·雄一郎", "Fujiwara Yuichiro");
  const texts = [
    { ...message("藤原·美咲来了"), userTranslation: "Fujiwara Misaki is here" },
    { ...message("美咲，你好"), userTranslation: "Misaki, hello" },
    { ...message("藤原·雄一郎来了"), userTranslation: "Fujiwara Yuichiro is here" },
    { ...message("藤原家"), userTranslation: "The Fujiwara house" },
  ];
  const glossary = [misaki, yuichiro];
  assert.deepStrictEqual(textsToClear({ texts, glossary }, misaki, false), texts.slice(0, 2));
});

it("clearing mismatches counts a name only where it stands as a whole word", () => {
  const rina = name("二阶堂·理娜", "Nikaido Rina");
  const texts = [
    { ...message("理娜姐姐"), userTranslation: "Rina-nee" },
    { ...message("理娜的工作"), userTranslation: "Rina's work" },
    { ...message("理娜大人"), userTranslation: "Lady Reena, the marina is open." },
    { ...message("理娜很认真"), userTranslation: "Reena is serious." },
  ];
  assert.deepStrictEqual(textsToClear({ texts, glossary: [rina] }, rina, true), texts.slice(2));
});
