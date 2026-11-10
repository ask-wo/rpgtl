import { assert, it } from "@effect/vitest";
import type { Entry, GlossaryTerm } from "@rpgtl/contracts";
import {
  entriesToClear,
  givenNameTranslation,
  shortNameTranslation,
  shortNameTranslations,
} from "./index.ts";

let counter = 0;
const message = (source: string, speaker?: string): Entry => ({
  id: `m${++counter}`,
  file: "Map001.json",
  path: ["events", "1", "pages", "0", "list", String(counter), "parameters", "0"],
  source: speaker ? `\\n<${speaker}>${source}` : source,
  translation: {},
});
const name = (source: string, translation: string): GlossaryTerm => ({
  source,
  translation: { user: translation },
  kind: { guess: { value: "character" } },
});

it("the short form of a dotted name takes the last word of its translation", () => {
  assert.strictEqual(shortNameTranslation("藤原·美咲", "Fujiwara Misaki"), "Misaki");
  assert.strictEqual(shortNameTranslation("魔法少女·美咲", "Magical Girl Misaki"), "Misaki");
  assert.isUndefined(shortNameTranslation("藤原·美咲", "Misaki"));
  assert.isUndefined(shortNameTranslation("美咲", "Misaki"));
});

const mapLine = (source: string): Entry => ({
  id: source,
  file: "Map001.json",
  path: [],
  source,
  translation: {},
});

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
  const entries = [
    { ...message("艾琳娜姐说得对"), translation: { user: "Cecyru-nee is right" } },
    { ...message("艾琳娜姐来了"), translation: { user: "Irena-nee is here" } },
  ];
  assert.deepStrictEqual(entriesToClear({ entries, glossary: [cecile] }, cecile, true), [
    entries[0],
  ]);
});

it("clearing mismatches keeps a line that uses the English, whatever its pronouns", () => {
  const misaki: GlossaryTerm = {
    ...name("藤原·美咲", "Fujiwara Misaki"),
    pronoun: { user: "she" },
  };
  const entry = {
    ...message("藤原·美咲来了"),
    translation: { user: "Fujiwara Misaki gave him the key" },
  };
  assert.deepStrictEqual(
    entriesToClear({ entries: [entry], glossary: [misaki] }, misaki, true),
    [],
  );
});

it("clearing a dotted name's mismatches also finds lines that use its short form", () => {
  const haruna = name("藤原·美咲", "Fujiwara Misaki");
  const entries = [
    { ...message("美咲，你好"), translation: { user: "Chunai, hello" } },
    { ...message("美咲来了"), translation: { user: "Misaki is here" } },
    { ...message("藤原·美咲来了"), translation: { user: "Misaki is here" } },
    { ...message("藤原·美咲走了"), translation: { user: "Fujiwara Misaki left" } },
  ];
  const glossary = [haruna, name("藤原·雄一郎", "Fujiwara Yuichiro")];
  assert.deepStrictEqual(entriesToClear({ entries, glossary }, haruna, true), [
    entries[0],
    entries[2],
  ]);
  assert.deepStrictEqual(entriesToClear({ entries, glossary }, haruna, false), entries);
  const twins = [haruna, name("西园·美咲", "Saionji Misaki")];
  assert.deepStrictEqual(entriesToClear({ entries, glossary: twins }, haruna, true), [
    entries[0],
    entries[2],
  ]);
  const conflicting = [haruna, name("西园·美咲", "Saionji Chunna")];
  assert.deepStrictEqual(entriesToClear({ entries, glossary: conflicting }, haruna, true), [
    entries[2],
  ]);
  const explicit = [...conflicting, name("美咲", "Hana")];
  assert.deepStrictEqual(
    entriesToClear({ entries, glossary: explicit }, haruna, true),
    entries.slice(0, 3),
  );
});

it("clearing all of a character's lines leaves the lines of another with the same family name", () => {
  const misaki = name("藤原·美咲", "Fujiwara Misaki");
  const yuichiro = name("藤原·雄一郎", "Fujiwara Yuichiro");
  const entries = [
    { ...message("藤原·美咲来了"), translation: { user: "Fujiwara Misaki is here" } },
    { ...message("美咲，你好"), translation: { user: "Misaki, hello" } },
    { ...message("藤原·雄一郎来了"), translation: { user: "Fujiwara Yuichiro is here" } },
    { ...message("藤原家"), translation: { user: "The Fujiwara house" } },
  ];
  const glossary = [misaki, yuichiro];
  assert.deepStrictEqual(entriesToClear({ entries, glossary }, misaki, false), entries.slice(0, 2));
});

it("clearing mismatches counts a name only where it stands as a whole word", () => {
  const rina = name("二阶堂·理娜", "Nikaido Rina");
  const entries = [
    { ...message("理娜姐姐"), translation: { user: "Rina-nee" } },
    { ...message("理娜的工作"), translation: { user: "Rina's work" } },
    { ...message("理娜大人"), translation: { user: "Lady Reena, the marina is open." } },
    { ...message("理娜很认真"), translation: { user: "Reena is serious." } },
  ];
  assert.deepStrictEqual(
    entriesToClear({ entries, glossary: [rina] }, rina, true),
    entries.slice(2),
  );
});
