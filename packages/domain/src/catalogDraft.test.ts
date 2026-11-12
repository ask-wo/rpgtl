import { assert, it } from "@effect/vitest";
import type { Catalog, Entry, GlossaryTerm } from "@rpgtl/contracts";
import { CatalogDraft, entryTranslation } from "./index.ts";

const line = (id: string, index: number, source: string, list = 1): Entry => ({
  id,
  location: {
    _tag: "Message",
    list: { _tag: "MapEventPage", map: 1, event: list, page: 0 },
    index: index,
  },
  source,
  translation: {},
});

const catalogOf = (entries: ReadonlyArray<Entry>): Catalog => ({
  version: 1,
  game: { id: "0123456789abcdef0123", title: "雨", engine: "MV" },
  translate: true,
  entries: [...entries],
  glossary: [],
});

const run = "2026-11-04T10:00:00.000Z";
const draftOf = (...entries: ReadonlyArray<Entry>) =>
  new CatalogDraft(catalogOf(entries), new Map(), run);

it("a label's room counts as tight against the English its kana or Hangul usually need", () => {
  const label = line("a", 0, "불러오기");
  const draft = new CatalogDraft(catalogOf([label]), new Map([["a", 6]]));
  assert.strictEqual(draft.tightLimit(draft.prepare(label)), 6);
});

it("a rejected answer stays as a suggestion until the entry is translated", () => {
  const draft = draftOf(line("a", 0, "你好"));
  const [entry] = draft.entries;
  assert.isDefined(entry);
  draft.suggest(draft.prepare(entry), "Hello 你", "source text left");
  assert.deepStrictEqual(draft.catalog.entries[0]?.suggestion, {
    text: "Hello 你",
    reason: "source text left",
  });
  draft.accept(draft.prepare(entry), "Hello");
  assert.deepStrictEqual(draft.catalog.entries[0], {
    ...line("a", 0, "你好"),
    translation: { guess: { value: "Hello", run } },
  });
});

it("a copy filled by repeated text drops its rejected answer, and its previous English once it is that again", () => {
  const rejected = { text: "Hi 你", reason: "source text left" };
  const draft = draftOf(
    { ...line("a", 0, "你好"), suggestion: rejected },
    { ...line("b", 0, "你好", 2), suggestion: rejected, previous: "Hello" },
    { ...line("c", 0, "你好", 3), previous: "Hey" },
  );
  const [first] = draft.entries;
  assert.isDefined(first);
  draft.accept(draft.prepare(first), "Hello");
  const filled = { translation: { guess: { value: "Hello", run } } };
  assert.deepStrictEqual(draft.catalog.entries, [
    { ...line("a", 0, "你好"), ...filled },
    { ...line("b", 0, "你好", 2), ...filled },
    { ...line("c", 0, "你好", 3), ...filled, previous: "Hey" },
  ]);
});

it("repeated text takes the first accepted translation, and a failed copy no longer counts", () => {
  const draft = draftOf(line("a", 0, "你好"), line("b", 0, "你好", 2));
  const [first, second] = draft.entries;
  assert.isDefined(first);
  assert.isDefined(second);
  draft.fail(second);
  draft.accept(draft.prepare(first), "Hello", { flag: "check this" });
  assert.deepStrictEqual(
    draft.catalog.entries.map((entry) => entry.translation),
    [
      { guess: { value: "Hello", run, flag: "check this" } },
      { guess: { value: "Hello", run, flag: "check this" } },
    ],
  );
  assert.deepStrictEqual(draft.failed, []);
});

const button = (id: string): Entry => ({
  id,
  location: { _tag: "ImageLines", image: `img/titles2/${id}`, lines: [0] },
  source: "致谢",
  translation: {},
});

it("image text takes repeated translations only from image text", () => {
  const command: Entry = {
    id: "plugin",
    location: { _tag: "PluginSetting", plugin: "Credits", keys: ["Command Name"] },
    source: "致谢",
    translation: { user: "Acknowledgments" },
  };
  const draft = draftOf(command, button("Command_3"), button("Credits"));
  const [, first, second] = draft.entries;
  assert.isDefined(first);
  assert.isDefined(second);
  assert.strictEqual(entryTranslation(first), "");
  draft.accept(draft.prepare(first), "Credits");
  assert.deepStrictEqual(draft.catalog.entries.map(entryTranslation), [
    "Acknowledgments",
    "Credits",
    "Credits",
  ]);
});

it("a glossary pass answer becomes a glossary term, and the term wins over a later answer", () => {
  const actor: Entry = {
    id: "actor",
    location: { _tag: "RecordField", table: "actors", record: 1, field: "name" },
    source: "艾琳",
    translation: {},
  };
  const draft = draftOf(actor, {
    ...actor,
    id: "again",
    location: { _tag: "RecordField", table: "actors", record: 2, field: "name" },
  });
  const [first, second] = draft.entries;
  assert.isDefined(first);
  assert.isDefined(second);
  draft.accept(draft.prepare(first), "Arlene", { seedGlossary: true });
  assert.strictEqual(entryTranslation(second), "Arlene");
  assert.deepStrictEqual(draft.catalog.glossary, [
    {
      source: "艾琳",
      translation: { guess: { value: "Arlene", run } },
      kind: { guess: { value: "character" } },
    },
  ]);
});

const term = (source: string, kind: GlossaryTerm["kind"]): GlossaryTerm => ({
  source,
  translation: { guess: { value: source, run: "earlier" } },
  kind,
});

it("the model sorts only terms the rules sorted, and its kinds and pronouns are the run's guesses", () => {
  const draft = new CatalogDraft(
    {
      ...catalogOf([line("a", 0, "林雨来了"), line("b", 1, "白雪来了"), line("c", 2, "小黑来了")]),
      glossary: [
        term("林雨", { guess: { value: "name" } }),
        term("白雪", { guess: { value: "name" }, user: "character" }),
        term("小黑", { guess: { value: "name", run: "earlier" } }),
      ],
    },
    new Map(),
    run,
  );
  const [first] = draft.termsToSort();
  assert.deepStrictEqual(
    draft.termsToSort().map((each) => each.term.source),
    ["林雨"],
  );
  if (!first) return;
  draft.setKind(first.term, "character");
  draft.setPronoun(first.term, "she");
  assert.deepStrictEqual(draft.catalog.glossary[0], {
    ...term("林雨", { guess: { value: "character", run } }),
    pronoun: { guess: { value: "she", run } },
  });
});

it("a first line that is only a glossary name is the speaker, kept on its own line in English", () => {
  const draft = new CatalogDraft(
    {
      ...catalogOf([
        line("a", 0, "\\C[2]ミナ\\C[0]\nと、とにかく逃げて！"),
        line("b", 1, "ミナに会う\nまた明日"),
      ]),
      glossary: [
        { source: "ミナ", translation: { user: "Mina" }, kind: { guess: { value: "character" } } },
      ],
    },
    new Map(),
    run,
  );
  const [named, sentence] = draft.entries;
  assert.isDefined(named);
  assert.isDefined(sentence);
  const item = draft.prepare(named);
  assert.strictEqual(item.text, "と、とにかく逃げて！");
  assert.strictEqual(draft.speaker(item), "Mina");
  assert.deepStrictEqual(draft.answerContext(item).speaker, {
    source: "ミナ",
    translation: "Mina",
  });
  draft.accept(item, "\\C[2]ミナ\\C[0]\nJ-just run!");
  assert.strictEqual(
    draft.catalog.entries[0]?.translation.guess?.value,
    "\\C[2]Mina\\C[0]\nJ-just run!",
  );
  assert.strictEqual(draft.prepare(sentence).text, "ミナに会うまた明日");
});
