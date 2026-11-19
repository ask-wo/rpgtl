import { assert, it } from "@effect/vitest";
import type { Catalog, GlossaryTerm } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import {
  newEntry,
  requestGlossary,
  termEdit,
  translationInUse,
  withGlossary,
  withTermLinesCleared,
  withTermTranslationsCleared,
} from "./index.ts";
import { testCatalog, testTerm } from "./testUtils/catalog.ts";

const line = (index: number, source: string, translation: string) => ({
  ...newEntry(
    { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 }, index: index },
    source,
  ),
  ...(translation && { userTranslation: translation }),
});
const fromRun = (modelTranslation: string) => ({ modelTranslation, modelOperationId: 1 });
const arlene = testTerm("阿琳", {
  ...fromRun("Arlene"),
  rulesKind: "name",
  modelKind: "character",
});
const named = { ...line(0, "阿琳", ""), ...fromRun("Arlene"), flagReason: "Check the name" };
const catalog = testCatalog({
  entries: [
    named,
    line(1, "阿琳来了", "Arlene is here"),
    line(2, "阿琳走了", "Irene left"),
    line(3, "你好", "Hello"),
  ],
  glossary: [arlene],
});

it("a saved glossary renames the texts that are exactly a renamed term, and only those", () => {
  const saved = Result.getOrThrow(
    withGlossary(catalog, [{ source: "阿琳", userTranslation: "Irene", userPronoun: "she" }]),
  );
  assert.deepStrictEqual(saved.texts.map(translationInUse), [
    "Irene",
    "Arlene is here",
    "Irene left",
    "Hello",
  ]);
  assert.deepStrictEqual(saved.texts[0], {
    ...catalog.texts[0],
    id: 1,
    source: "阿琳",
    isInImage: false,
    userTranslation: "Irene",
  });
  assert.strictEqual(saved.glossary[0]?.userPronoun, "she");
});

const item = (source: string, value: string) =>
  testTerm(source, { ...fromRun(value), rulesKind: "name" });

it("renaming a term renames it in the run's English of the terms that contain it", () => {
  const umbrella = item("阿琳的伞", "Arlene's Umbrella");
  const typed = { ...item("阿琳的鞋", "Arlene's Shoes"), userTranslation: "Arlene's Boots" };
  const longer = item("阿琳娜", "Arlenea");
  const withItems = testCatalog({
    entries: [
      named,
      line(1, "阿琳来了", "Arlene is here"),
      line(2, "阿琳走了", "Irene left"),
      line(3, "你好", "Hello"),
      line(4, "阿琳的伞", "Arlene's Umbrella"),
    ],
    glossary: [arlene, umbrella, typed, longer],
  });
  const saved = Result.getOrThrow(
    withGlossary(withItems, [
      { source: "阿琳", userTranslation: "Irene" },
      ...[umbrella, typed, longer].map(termEdit),
    ]),
  );
  assert.deepStrictEqual(saved.glossary.map(translationInUse), [
    "Irene",
    "Irene's Umbrella",
    "Arlene's Boots",
    "Arlenea",
  ]);
  assert.strictEqual(saved.texts.map(translationInUse).at(-1), "Irene's Umbrella");
  const rest = [umbrella, typed, longer].map(termEdit);
  const emptied = Result.getOrThrow(
    withGlossary(withItems, [{ source: "阿琳", userTranslation: "" }, ...rest]),
  );
  const retyped = Result.getOrThrow(
    withGlossary(emptied, [{ source: "阿琳", userTranslation: "Irene" }, ...rest]),
  );
  assert.strictEqual(retyped.glossary.map(translationInUse)[1], "Irene's Umbrella");
});

it("a term's English saved blank or with spaces around it renames no text to that", () => {
  const blank = Result.getOrThrow(
    withGlossary(catalog, [{ source: "阿琳", userTranslation: " " }]),
  );
  assert.deepStrictEqual(blank.texts, catalog.texts);
  const spaced = Result.getOrThrow(
    withGlossary(catalog, [{ source: "阿琳", userTranslation: "Irene " }]),
  );
  assert.strictEqual(spaced.texts[0] && translationInUse(spaced.texts[0]), "Irene");
});

it("a saved glossary drops the pronoun of a term that is no longer a character", () => {
  const saved = Result.getOrThrow(
    withGlossary(catalog, [{ source: "阿琳", userKind: "name", userPronoun: "she" }]),
  );
  assert.deepStrictEqual(saved.glossary, [{ ...arlene, userKind: "name" }]);
});

it("a term's note is saved trimmed, goes with the term to the model, and is dropped when blank", () => {
  const noted = Result.getOrThrow(
    withGlossary(catalog, [{ ...termEdit(arlene), userNote: "  Plural: Arlenes " }]),
  );
  assert.deepStrictEqual(requestGlossary(noted.glossary, [{ text: "阿琳来了" }]), [
    { source: "阿琳", translation: "Arlene", note: "Plural: Arlenes" },
  ]);
  const blank = Result.getOrThrow(withGlossary(noted, [{ source: "阿琳", userNote: " " }]));
  assert.deepStrictEqual(blank.glossary, [arlene]);
});

it("a saved term keeps its run's values beside the user's, and without them goes back to the run's", () => {
  const edited = Result.getOrThrow(
    withGlossary(catalog, [{ source: "阿琳", userTranslation: "Irene", userKind: "name" }]),
  );
  assert.deepStrictEqual(edited.glossary, [
    { ...arlene, userTranslation: "Irene", userKind: "name" },
  ]);
  const back = Result.getOrThrow(withGlossary(edited, [termEdit(arlene)]));
  assert.deepStrictEqual(back.glossary, [arlene]);
  const added = Result.getOrThrow(
    withGlossary(catalog, [{ source: "米娅", userTranslation: "Mia" }]),
  );
  assert.deepStrictEqual(added.glossary, [
    { id: -1, source: "米娅", rulesKind: "name", userTranslation: "Mia" },
  ]);
});

it("a cleared term keeps the English it had, the user's if they typed it, until the user types English again", () => {
  const emptied = Result.getOrThrow(
    withGlossary(catalog, [{ source: "阿琳", userTranslation: "" }]),
  );
  assert.strictEqual(emptied.glossary[0]?.previousTranslation, "Arlene");
  const retyped = Result.getOrThrow(
    withGlossary(catalog, [{ source: "阿琳", userTranslation: "Arlena" }]),
  );
  const emptiedTyped = Result.getOrThrow(
    withGlossary(retyped, [{ source: "阿琳", userTranslation: "" }]),
  );
  assert.strictEqual(emptiedTyped.glossary[0]?.previousTranslation, "Arlena");
  const typed = Result.getOrThrow(
    withGlossary(emptied, [{ source: "阿琳", userTranslation: "Irene" }]),
  ).glossary[0];
  assert.strictEqual(typed && translationInUse(typed), "Irene");
  assert.isUndefined(typed?.previousTranslation);
});

it("a glossary that lists a source twice isn't saved, and the error names it", () => {
  const result = withGlossary(catalog, [
    termEdit(arlene),
    { source: "阿琳", userTranslation: "Irene" },
  ]);
  assert.isTrue(Result.isFailure(result));
  if (Result.isFailure(result)) assert.include(result.failure.message, "阿琳");
});

it("clearing mismatches clears the terms' texts that don't use the English, keeping it as previous", () => {
  const { catalog: next, cleared } = withTermLinesCleared(catalog, ["阿琳"], true);
  assert.strictEqual(cleared, 1);
  assert.deepStrictEqual(next.texts[2], {
    id: 3,
    source: "阿琳走了",
    isInImage: false,
    previousTranslation: "Irene left",
  });
  assert.deepStrictEqual(next.texts.slice(0, 2), catalog.texts.slice(0, 2));
  assert.strictEqual(withTermLinesCleared(catalog, ["米娅"], true).cleared, 0);
  const unnamed: Catalog = { ...catalog, glossary: [testTerm("阿琳", { rulesKind: "character" })] };
  assert.strictEqual(withTermLinesCleared(unnamed, ["阿琳"], true).cleared, 0);
});

it("clearing a term's lines clears every translated text with it, with or without its English", () => {
  const { catalog: next, cleared } = withTermLinesCleared(catalog, ["阿琳"], false);
  assert.strictEqual(cleared, 3);
  assert.deepStrictEqual(next.texts.map(translationInUse), ["", "", "", "Hello"]);
  const unnamed: Catalog = { ...catalog, glossary: [testTerm("阿琳", { rulesKind: "character" })] };
  assert.strictEqual(withTermLinesCleared(unnamed, ["阿琳"], false).cleared, 3);
});

it("clearing terms' run English clears the run's English of the texts with them, and keeps what the user typed", () => {
  const guessed = (index: number, source: string, value: string) => ({
    ...line(index, source, ""),
    ...fromRun(value),
  });
  const song: GlossaryTerm = item("阿琳之歌", "Irene's Song");
  const dream: GlossaryTerm = item("阿琳之梦", "Irene's Dream");
  const {
    catalog: next,
    terms,
    texts,
  } = withTermTranslationsCleared(
    testCatalog({
      entries: [
        guessed(0, "阿琳之歌", "Irene's Song"),
        guessed(1, "唱阿琳之歌", "Sing Irene's Song"),
        line(2, "阿琳之歌响起", "Irene's Song plays"),
        guessed(3, "阿琳走了", "Irene left"),
      ],
      glossary: [arlene, song, dream],
    }),
    ["阿琳之歌", "阿琳之梦"],
  );
  assert.deepStrictEqual([terms, texts], [1, 2]);
  assert.deepStrictEqual(next.glossary.map(translationInUse), ["Arlene", "", "Irene's Dream"]);
  assert.strictEqual(next.glossary[1]?.previousTranslation, "Irene's Song");
  assert.deepStrictEqual(next.texts.map(translationInUse), [
    "",
    "",
    "Irene's Song plays",
    "Irene left",
  ]);
});

it("an XP database name is a term's own entry without its tags", () => {
  const term = item("阿琳之歌", "Irene's Song");
  const entry = {
    ...newEntry({ _tag: "RecordField", table: "skills", record: 1, field: "name" }, "阿琳之歌[A5]"),
    ...fromRun("Irene's Song[A5]"),
  };
  const { terms, texts } = withTermTranslationsCleared(
    testCatalog({ entries: [entry], glossary: [term], engine: "XP" }),
    ["阿琳之歌"],
  );
  assert.deepStrictEqual([terms, texts], [1, 1]);
});
