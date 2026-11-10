import { assert, it } from "@effect/vitest";
import type { Catalog, GlossaryTerm } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import {
  entryTranslation,
  newEntry,
  termEdit,
  withGlossary,
  withTermLinesCleared,
} from "./index.ts";

const line = (index: number, source: string, translation: string) => ({
  ...newEntry("Map001.json", ["events", "1", "pages", "0", "list", String(index)], source),
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
