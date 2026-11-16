import { assert, it } from "@effect/vitest";
import type { GlossaryTerm } from "@rpgtl/contracts";
import { CatalogDraft, termPronoun, translationInUse, speakerEntries } from "./index.ts";
import { type TestEntry, testCatalog, testTerm } from "./testUtils/catalog.ts";

const line = (id: string, index: number, source: string, list = 1) => ({
  id,
  location: {
    _tag: "Message" as const,
    list: { _tag: "MapEventPage" as const, map: 1, event: list, page: 0 },
    index: index,
  },
  source,
});

const draftOf = (...entries: ReadonlyArray<TestEntry>) =>
  new CatalogDraft(testCatalog({ entries }), new Map());
const withGlossary = (
  entries: ReadonlyArray<TestEntry>,
  glossary: ReadonlyArray<GlossaryTerm>,
  engine: "MV" | "XP" = "MV",
) => new CatalogDraft(testCatalog({ entries, glossary, engine }), new Map());

it("a label's room counts as tight against the English its kana or Hangul usually need", () => {
  const draft = new CatalogDraft(
    testCatalog({ entries: [line("a", 0, "불러오기")] }),
    new Map([["a", 6]]),
  );
  const [label] = draft.entries;
  assert.isDefined(label);
  assert.strictEqual(draft.tightLimit(draft.prepare(label)), 6);
});

const scriptString = (id: string, source: string, builtinTranslation: string) => ({
  ...line(id, 0, source),
  location: {
    _tag: "RubyScriptText" as const,
    script: 0,
    name: "Window_Sail",
    literal: Number(id),
  },
  builtinTranslation,
});

it("a script string has room for 5/3 of the wider of its source and the game's English, which a `????` doesn't give", () => {
  const draft = draftOf(
    scriptString("0", "帆柱の綱", "Mstb"),
    scriptString("1", "帆柱", "\\C[2]Mast lines"),
    scriptString("2", "帆柱", "????"),
  );
  assert.deepStrictEqual(
    draft.entries.map((entry) => draft.limit(entry)),
    [Math.ceil((5 / 3) * 4 * 1.8), Math.ceil((5 / 3) * 10), undefined],
  );
});

it("a rejected answer stays on the text until the text is translated", () => {
  const draft = draftOf(line("a", 0, "你好"));
  const [entry] = draft.entries;
  assert.isDefined(entry);
  draft.suggest(draft.prepare(entry), "Hello 你", "source text left");
  assert.deepStrictEqual(
    [entry.rejectedTranslation, entry.rejectionReason],
    ["Hello 你", "source text left"],
  );
  draft.accept(draft.prepare(entry), "Hello");
  assert.deepStrictEqual(draft.takeChanges(), {
    texts: [{ id: 1, modelTranslation: "Hello" }],
    terms: [],
  });
  assert.deepStrictEqual(draft.takeChanges(), { texts: [], terms: [] });
});

it("every entry of a text takes the accepted translation, and a failed one no longer counts", () => {
  const draft = draftOf(line("a", 0, "你好"), line("b", 0, "你好", 2));
  const [first, second] = draft.entries;
  assert.isDefined(first);
  assert.isDefined(second);
  draft.fail(second);
  draft.accept(draft.prepare(first), "Hello", { flag: "check this" });
  assert.deepStrictEqual(
    draft.entries.map(({ modelTranslation, flagReason }) => [modelTranslation, flagReason]),
    [
      ["Hello", "check this"],
      ["Hello", "check this"],
    ],
  );
  assert.deepStrictEqual(draft.failed, []);
  assert.deepStrictEqual(draft.takeChanges().texts, [
    { id: 1, modelTranslation: "Hello", flagReason: "check this" },
  ]);
});

const button = (id: string) => ({
  id,
  location: { _tag: "ImageLines" as const, image: `img/titles2/${id}`, lines: [0] },
  source: "致谢",
});

it("image text is translated apart from the same words in the game's data", () => {
  const command = {
    id: "plugin",
    location: { _tag: "PluginSetting" as const, plugin: "Credits", keys: ["Command Name"] },
    source: "致谢",
    userTranslation: "Acknowledgments",
  };
  const draft = draftOf(command, button("Command_3"), button("Credits"));
  const [, first, second] = draft.entries;
  assert.isDefined(first);
  assert.isDefined(second);
  assert.strictEqual(translationInUse(first), "");
  draft.accept(draft.prepare(first), "Credits");
  assert.deepStrictEqual(draft.entries.map(translationInUse), [
    "Acknowledgments",
    "Credits",
    "Credits",
  ]);
});

it("a glossary pass answer becomes a glossary term, and the term wins over a later answer", () => {
  const actor = {
    id: "actor",
    location: { _tag: "RecordField" as const, table: "actors" as const, record: 1, field: "name" },
    source: "艾琳",
  };
  const draft = draftOf(actor, {
    ...actor,
    id: "again",
    location: { ...actor.location, record: 2 },
  });
  const [first, second] = draft.entries;
  assert.isDefined(first);
  assert.isDefined(second);
  draft.accept(draft.prepare(first), "Arlene", { seedGlossary: true });
  assert.strictEqual(translationInUse(second), "Arlene");
  const added = {
    id: -1,
    source: "艾琳",
    modelTranslation: "Arlene",
    rulesKind: "character" as const,
  };
  assert.deepStrictEqual(draft.glossary, [added]);
  assert.deepStrictEqual(draft.takeChanges().terms, [added]);
});

it("an XP name's tags stay out of its request and its glossary term", () => {
  const enemy = {
    id: "enemy",
    location: { _tag: "RecordField" as const, table: "enemies" as const, record: 3, field: "name" },
    source: "[LV9]ホロネ{本体}",
  };
  const draft = withGlossary([enemy], [], "XP");
  const [entry] = draft.entries;
  assert.isDefined(entry);
  const item = draft.prepare(entry);
  assert.strictEqual(item.text, "ホロネ");
  draft.accept(item, "[LV9]Horone{本体}", { seedGlossary: true });
  assert.strictEqual(translationInUse(entry), "[LV9]Horone{本体}");
  assert.deepStrictEqual(
    draft.glossary.map((term) => [term.source, term.modelTranslation]),
    [["ホロネ", "Horone"]],
  );
});

const term = (source: string, fields: Partial<GlossaryTerm> = {}) =>
  testTerm(source, { modelTranslation: source, modelOperationId: 1, ...fields });

it("the model sorts only terms it and the user haven't sorted, and gives them its kinds and pronouns", () => {
  const lin = term("林雨", { rulesKind: "name" });
  const draft = withGlossary(
    [line("a", 0, "林雨来了"), line("b", 1, "白雪来了"), line("c", 2, "小黑来了")],
    [
      lin,
      term("白雪", { rulesKind: "name", userKind: "character" }),
      term("小黑", { rulesKind: "name", modelKind: "name" }),
    ],
  );
  const [first] = draft.termsToSort();
  assert.deepStrictEqual(
    draft.termsToSort().map((each) => each.term.source),
    ["林雨"],
  );
  if (!first) return;
  draft.setKind(first.term, "character");
  draft.setPronoun(first.term, "she");
  assert.deepStrictEqual(draft.glossary[0], {
    ...lin,
    modelKind: "character",
    modelPronoun: "she",
  });
});

it("a name made only of control codes is no glossary term, so the model is never asked about it", () => {
  const draft = withGlossary(
    [line("a", 0, "\\N[7]来了"), line("b", 1, "她说\\N[7]来了")],
    [term("\\N[7]", { rulesKind: "character" })],
  );
  assert.isUndefined(draft.addTerm("\\N[8]", "\\N[8]", false));
  assert.deepStrictEqual(draft.termsToSort(), []);
  assert.deepStrictEqual(draft.pronounsFromClues(), []);
  assert.deepStrictEqual(
    draft.glossary.map((each) => [each.source, termPronoun(each)]),
    [["\\N[7]", undefined]],
  );
});

it("a speaker whose term was cleared is translated again, and its English fills the term", () => {
  const message = line("a", 0, "林雨\n你好");
  const cleared = testTerm("林雨", {
    rulesKind: "character",
    modelKind: "character",
    previousTranslation: "Lin Yu",
  });
  const draft = withGlossary([message], [cleared]);
  const [entry] = draft.entries;
  assert.isDefined(entry);
  const prepared = draft.prepare(entry);
  assert.strictEqual(draft.speaker(prepared), "林雨");
  assert.deepStrictEqual(
    speakerEntries(draft, [prepared]).map((each) => each.id),
    ["speaker:林雨"],
  );
  draft.addTerm("林雨", "Lin Yu", true);
  const { previousTranslation: _, ...rest } = cleared;
  assert.deepStrictEqual(draft.glossary, [{ ...rest, modelTranslation: "Lin Yu" }]);
});

it("a first line that is only a glossary name is the speaker, kept on its own line in English", () => {
  const draft = withGlossary(
    [line("a", 0, "\\C[2]ミナ\\C[0]\nと、とにかく逃げて！"), line("b", 1, "ミナに会う\nまた明日")],
    [testTerm("ミナ", { userTranslation: "Mina", rulesKind: "character" })],
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
  assert.strictEqual(named.modelTranslation, "\\C[2]Mina\\C[0]\nJ-just run!");
  assert.strictEqual(draft.prepare(sentence).text, "ミナに会うまた明日");
});

it("a speaker named only by a control code the game fills in isn't a speaker to translate", () => {
  const draft = draftOf(line("a", 0, "\\n<\\N[3]>你好"), line("b", 1, "\\n<林雨>再见"));
  assert.deepStrictEqual(
    speakerEntries(
      draft,
      draft.entries.map((entry) => draft.prepare(entry)),
    ).map(({ id }) => id),
    ["speaker:林雨"],
  );
});
