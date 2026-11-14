import { assert, it } from "@effect/vitest";
import type { Catalog, GlossaryTerm } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import {
  entryTranslation,
  newEntry,
  termEdit,
  termTranslation,
  withGlossary,
  withTermGuessesCleared,
  withTermLinesCleared,
} from "./index.ts";

const line = (index: number, source: string, translation: string) => ({
  ...newEntry(
    { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 }, index: index },
    source,
  ),
  translation: translation ? { user: translation } : {},
});
const run = "2026-11-04T10:00:00.000Z";
const arlene: GlossaryTerm = {
  source: "阿琳",
  translation: { guess: { value: "Arlene", run } },
  kind: { guess: { value: "character", run } },
};
const named = {
  ...line(0, "阿琳", ""),
  translation: { guess: { value: "Arlene", run, flag: "Check the name" } },
};
const catalog: Catalog = {
  version: 1,
  game: { id: "g", title: "G", engine: "MZ" },
  translate: true,
  entries: [
    named,
    line(1, "阿琳来了", "Arlene is here"),
    line(2, "阿琳走了", "Irene left"),
    line(3, "你好", "Hello"),
  ],
  glossary: [arlene],
};

it("a saved glossary renames the entries that are exactly a renamed term, and only those", () => {
  const saved = Result.getOrThrow(
    withGlossary(catalog, [{ source: "阿琳", translation: "Irene", pronoun: "she" }]),
  );
  assert.deepStrictEqual(saved.entries.map(entryTranslation), [
    "Irene",
    "Arlene is here",
    "Irene left",
    "Hello",
  ]);
  assert.deepStrictEqual(saved.entries[0]?.translation, { guess: { value: "Irene" } });
  assert.deepStrictEqual(saved.glossary[0]?.pronoun, { user: "she" });
});

const item = (source: string, value: string): GlossaryTerm => ({
  source,
  translation: { guess: { value, run } },
  kind: { guess: { value: "name", run } },
});

it("renaming a term renames it in the run's English of the terms that contain it", () => {
  const umbrella = item("阿琳的伞", "Arlene's Umbrella");
  const typed = { ...item("阿琳的鞋", "Arlene's Shoes"), translation: { user: "Arlene's Boots" } };
  const longer = item("阿琳娜", "Arlenea");
  const withItems: Catalog = {
    ...catalog,
    entries: [...catalog.entries, line(4, "阿琳的伞", "Arlene's Umbrella")],
    glossary: [arlene, umbrella, typed, longer],
  };
  const saved = Result.getOrThrow(
    withGlossary(withItems, [
      { source: "阿琳", translation: "Irene" },
      ...[umbrella, typed, longer].map(termEdit),
    ]),
  );
  assert.deepStrictEqual(saved.glossary.map(termTranslation), [
    "Irene",
    "Irene's Umbrella",
    "Arlene's Boots",
    "Arlenea",
  ]);
  assert.strictEqual(saved.entries.map(entryTranslation).at(-1), "Irene's Umbrella");
  const rest = [umbrella, typed, longer].map(termEdit);
  const emptied = Result.getOrThrow(
    withGlossary(withItems, [{ source: "阿琳", translation: "" }, ...rest]),
  );
  const retyped = Result.getOrThrow(
    withGlossary(emptied, [{ source: "阿琳", translation: "Irene" }, ...rest]),
  );
  assert.strictEqual(retyped.glossary.map(termTranslation)[1], "Irene's Umbrella");
});

it("a term's English saved blank or with spaces around it renames no entry to that", () => {
  const blank = Result.getOrThrow(withGlossary(catalog, [{ source: "阿琳", translation: " " }]));
  assert.deepStrictEqual(blank.entries, catalog.entries);
  const spaced = Result.getOrThrow(
    withGlossary(catalog, [{ source: "阿琳", translation: "Irene " }]),
  );
  assert.strictEqual(spaced.entries[0] && entryTranslation(spaced.entries[0]), "Irene");
});

it("a saved glossary drops the pronoun of a term that is no longer a character", () => {
  const saved = Result.getOrThrow(
    withGlossary(catalog, [{ source: "阿琳", kind: "name", pronoun: "she" }]),
  );
  assert.deepStrictEqual(saved.glossary, [{ ...arlene, kind: { ...arlene.kind, user: "name" } }]);
});

it("a saved term keeps its run's guesses beside the user's values, and without them goes back to the guesses", () => {
  const edited = Result.getOrThrow(
    withGlossary(catalog, [{ source: "阿琳", translation: "Irene", kind: "name" }]),
  );
  assert.deepStrictEqual(edited.glossary, [
    {
      ...arlene,
      translation: { ...arlene.translation, user: "Irene" },
      kind: { ...arlene.kind, user: "name" },
    },
  ]);
  const back = Result.getOrThrow(withGlossary(edited, [termEdit(arlene)]));
  assert.deepStrictEqual(back.glossary, [arlene]);
  const added = Result.getOrThrow(withGlossary(catalog, [{ source: "米娅", translation: "Mia" }]));
  assert.deepStrictEqual(added.glossary, [
    { source: "米娅", translation: { user: "Mia" }, kind: { guess: { value: "name" } } },
  ]);
});

it("a saved term keeps the English it had before clearing until the user types it again", () => {
  const emptied = Result.getOrThrow(withGlossary(catalog, [{ source: "阿琳", translation: "" }]));
  assert.strictEqual(emptied.glossary[0]?.previous, "Arlene");
  const cleared = { ...catalog, glossary: [{ ...arlene, translation: {}, previous: "Arlene" }] };
  const typed = (translation: string) =>
    Result.getOrThrow(withGlossary(cleared, [{ source: "阿琳", translation }])).glossary[0];
  assert.strictEqual(typed("Irene")?.previous, "Arlene");
  assert.isUndefined(typed("Arlene")?.previous);
});

it("a glossary that lists a source twice isn't saved, and the error names it", () => {
  const result = withGlossary(catalog, [
    termEdit(arlene),
    { source: "阿琳", translation: "Irene" },
  ]);
  assert.isTrue(Result.isFailure(result));
  if (Result.isFailure(result)) assert.include(result.failure.message, "阿琳");
});

it("clearing mismatches clears the terms' entries that don't use the English, keeping it as previous", () => {
  const { catalog: next, cleared } = withTermLinesCleared(catalog, ["阿琳"], true);
  assert.strictEqual(cleared, 1);
  assert.deepStrictEqual(next.entries[2], { ...line(2, "阿琳走了", ""), previous: "Irene left" });
  assert.deepStrictEqual(next.entries.slice(0, 2), catalog.entries.slice(0, 2));
  assert.strictEqual(next.translate, true);
  assert.strictEqual(withTermLinesCleared(catalog, ["米娅"], true).cleared, 0);
  const unnamed = { ...catalog, glossary: [{ ...arlene, translation: {} }] };
  assert.strictEqual(withTermLinesCleared(unnamed, ["阿琳"], true).cleared, 0);
});

it("clearing a term's lines clears every translated entry with it, with or without its English", () => {
  const { catalog: next, cleared } = withTermLinesCleared(catalog, ["阿琳"], false);
  assert.strictEqual(cleared, 3);
  assert.deepStrictEqual(next.entries.map(entryTranslation), ["", "", "", "Hello"]);
  const unnamed = { ...catalog, glossary: [{ ...arlene, translation: {} }] };
  assert.strictEqual(withTermLinesCleared(unnamed, ["阿琳"], false).cleared, 3);
});

it("clearing terms' run English clears the run's English of the entries with them, and keeps what the user typed", () => {
  const guessed = (index: number, source: string, value: string) => ({
    ...line(index, source, ""),
    translation: { guess: { value, run } },
  });
  const song: GlossaryTerm = {
    source: "阿琳之歌",
    translation: { guess: { value: "Irene's Song", run } },
    kind: { guess: { value: "name", run } },
  };
  const dream: GlossaryTerm = {
    source: "阿琳之梦",
    translation: { guess: { value: "Irene's Dream", run } },
    kind: { guess: { value: "name", run } },
  };
  const {
    catalog: next,
    terms,
    entries,
  } = withTermGuessesCleared(
    {
      ...catalog,
      entries: [
        guessed(0, "阿琳之歌", "Irene's Song"),
        guessed(1, "唱阿琳之歌", "Sing Irene's Song"),
        line(2, "阿琳之歌响起", "Irene's Song plays"),
        guessed(3, "阿琳走了", "Irene left"),
      ],
      glossary: [arlene, song, dream],
    },
    ["阿琳之歌", "阿琳之梦"],
  );
  assert.deepStrictEqual([terms, entries], [1, 2]);
  assert.deepStrictEqual(next.glossary.map(termTranslation), ["Arlene", "", "Irene's Dream"]);
  assert.strictEqual(next.glossary[1]?.previous, "Irene's Song");
  assert.deepStrictEqual(next.entries.map(entryTranslation), [
    "",
    "",
    "Irene's Song plays",
    "Irene left",
  ]);
});

it("an XP database name is a term's own entry without its tags", () => {
  const term: GlossaryTerm = {
    source: "阿琳之歌",
    translation: { guess: { value: "Irene's Song", run } },
    kind: { guess: { value: "name", run } },
  };
  const entry = {
    ...newEntry({ _tag: "RecordField", table: "skills", record: 1, field: "name" }, "阿琳之歌[A5]"),
    translation: { guess: { value: "Irene's Song[A5]", run } },
  };
  const { terms, entries } = withTermGuessesCleared(
    { ...catalog, game: { ...catalog.game, engine: "XP" }, entries: [entry], glossary: [term] },
    ["阿琳之歌"],
  );
  assert.deepStrictEqual([terms, entries], [1, 1]);
});
