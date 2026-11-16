import { assert, it } from "@effect/vitest";
import type { Catalog, ImageReadResults } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import * as Struct from "effect/Struct";
import {
  decodeTranslationFile,
  entryTexts,
  translationFile,
  translationInUse,
  importedImageText,
  importPreview,
  importTranslations,
  newEntry,
} from "./index.ts";
import { testCatalog, testTerm } from "./testUtils/catalog.ts";

const codex = {
  translator: "codex",
  model: "gpt-6.1-terra",
  glossaryModel: "gpt-6.1-sol",
} as const;
const started = "2026-11-04T10:00:00.000Z";
const greeting = newEntry(
  { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 }, index: 0 },
  "你好 \\N[1]!",
);
const label = newEntry(
  { _tag: "ImageLines", image: "img/menus/main/commands/Recalled", lines: [0] },
  "鉴赏",
);
const fromRun = { modelTranslation: "View", modelOperationId: 1 };
const current = testCatalog({
  entries: [greeting, { ...label, ...fromRun, unshortenedTranslation: "Appreciate" }],
  operations: [{ id: 1, kind: "run", startedAt: started, models: codex }],
});
const exported = translationFile(current, undefined);

const imported = (file: object, into: Catalog = current) =>
  decodeTranslationFile({ ...exported, ...file }).pipe(
    Result.flatMap((decoded) => importTranslations(into, decoded)),
  );
const problem = (result: Result.Result<unknown, { readonly problem: string }>) =>
  Result.isFailure(result) ? result.failure.problem : undefined;
const greetingText = (fields: object = {}) => ({
  source: greeting.source,
  isInImage: false,
  ...fields,
});
const labelText = (fields: object = {}) => ({ source: label.source, isInImage: true, ...fields });
const inUse = (catalog: Catalog) => entryTexts(catalog).map(translationInUse);

it("an export lists every text, the image entries with their text, and the runs whose English is still in use", () => {
  const catalog = {
    ...current,
    glossary: [testTerm("鉴赏", { modelTranslation: "View", modelOperationId: 1 })],
    operations: [...current.operations, { id: 2, kind: "run" as const, startedAt: "later" }],
  };
  assert.deepStrictEqual(translationFile(catalog, undefined), {
    version: 2,
    texts: [
      greetingText(),
      labelText({ modelTranslation: "View", unshortenedTranslation: "Appreciate" }),
    ],
    entries: [{ id: label.id, source: label.source }],
    glossary: [{ source: "鉴赏", rulesKind: "word", modelTranslation: "View" }],
    settings: {},
    operations: [{ kind: "run", startedAt: started, models: codex, values: 2 }],
  });
});

it("an export imported into the game it came from changes nothing", () => {
  const start = newEntry({ _tag: "ImageLines", image: "img/pictures/Title", lines: [1] }, "开使");
  const catalog = testCatalog({
    entries: [
      { ...greeting, userTranslation: "Hello \\N[1]!" },
      { ...label, ...fromRun, isLeftUntranslated: true },
      { ...start, source: "开始", userTranslation: "Start" },
    ],
    glossary: [
      testTerm("星澜", {
        modelTranslation: "Xinglan",
        rulesKind: "character",
        rulesPronoun: "she",
        sheClues: 2,
        heClues: 0,
        userPronoun: "she",
      }),
    ],
    settings: { sourceLanguage: "chinese", letteringFont: "serif", untranslatedImages: ["img/a"] },
    operations: current.operations,
  });
  const file = Result.getOrThrow(decodeTranslationFile(translationFile(catalog, undefined)));
  const after = Result.getOrThrow(importTranslations(catalog, file));
  assert.deepStrictEqual(after.entries, catalog.entries);
  assert.deepStrictEqual(
    after.texts,
    catalog.texts.map((text) => Struct.omit(text, ["modelOperationId"])),
  );
  assert.deepStrictEqual(
    after.glossary,
    catalog.glossary.map((term) => Struct.omit(term, ["modelOperationId"])),
  );
  assert.deepStrictEqual(after.settings, catalog.settings);
});

it("an import takes translations by text, from the same game in any folder, keeping control codes", () => {
  const hello = Result.getOrThrow(
    imported({ texts: [greetingText({ userTranslation: "Hello \\N[1]!" })] }),
  );
  assert.deepStrictEqual(inUse(hello), ["Hello \\N[1]!", "View"]);
  assert.strictEqual(
    problem(imported({ texts: [greetingText({ userTranslation: "Hello!" })] })),
    "controlCodes",
  );
  assert.strictEqual(
    problem(imported({ texts: [greetingText(), greetingText()] })),
    "duplicateText",
  );
  assert.strictEqual(
    problem(imported({ entries: [{ id: label.id }, { id: label.id }] })),
    "duplicateEntry",
  );
  assert.strictEqual(
    problem(imported({ entries: [{ id: greeting.id, isLeftUntranslated: true }] })),
    "leftUntranslated",
  );
  const other = { texts: [greetingText({ source: "再见" })], entries: [] };
  assert.strictEqual(problem(imported(other)), "otherGame");
  const korean = Result.getOrThrow(imported({ settings: { sourceLanguage: "korean" } }));
  assert.strictEqual(korean.settings.sourceLanguage, "korean");
});

it("a translation file from another RPGTL is turned down as newer or older, not as damaged", () => {
  assert.strictEqual(problem(imported({ version: 3, texts: "changed" })), "newer");
  assert.strictEqual(problem(imported({ version: 1, entries: [] })), "older");
  assert.strictEqual(problem(imported({ version: 2, texts: "changed" })), "format");
});

it("an import takes an image's corrected text with its English, and the text read undoes it", () => {
  const after = Result.getOrThrow(
    imported({
      entries: [{ id: label.id, source: "欣赏" }],
      texts: [labelText({ source: "欣赏", userTranslation: "Gallery" })],
    }),
  );
  const corrected = entryTexts(after)[1];
  assert.deepStrictEqual(
    [corrected?.source, corrected && translationInUse(corrected)],
    ["欣赏", "Gallery"],
  );
  const back = Result.getOrThrow(imported({}, after));
  assert.deepStrictEqual(entryTexts(back)[1]?.source, label.source);
  const misplaced = Result.getOrThrow(imported({ entries: [{ id: greeting.id, source: "你好" }] }));
  assert.deepStrictEqual(misplaced.entries, current.entries);
});

it("a file's text replaces the model's and the user's values of the game's text", () => {
  const after = Result.getOrThrow(
    imported({ texts: [labelText({ userTranslation: "Appreciate" })] }),
  );
  assert.deepStrictEqual(after.texts[1], {
    id: 2,
    source: label.source,
    isInImage: true,
    userTranslation: "Appreciate",
  });
  assert.deepStrictEqual(inUse(Result.getOrThrow(imported({ texts: [labelText()] }))), ["", ""]);
});

const result = (file: string) => ({ file, sha256: "s", width: 1, height: 1, lines: [] });

it("an import from another version of the game takes the texts it still has and leaves out the rest", () => {
  const file = Result.getOrThrow(
    decodeTranslationFile({
      ...exported,
      texts: [
        greetingText({ userTranslation: "Hello \\N[1]!" }),
        greetingText({ source: "再见", userTranslation: "Bye!" }),
        labelText({ source: "鉴赏 2", userTranslation: "View 2" }),
      ],
    }),
  );
  const after = Result.getOrThrow(importTranslations(current, file));
  assert.deepStrictEqual(inUse(after), ["Hello \\N[1]!", "View"]);
  assert.deepStrictEqual(
    importPreview(current, after, { version: 1, images: {}, runs: {} }, file).translations,
    { inFile: 3, added: 1, changed: 0, cleared: 0, notInGame: 2 },
  );
});

it("an imported glossary has trimmed terms listed once, and only characters keep a pronoun", () => {
  const term = { source: " 星澜 ", userTranslation: "Xinglan ", userPronoun: "she" };
  assert.deepStrictEqual(
    Result.getOrThrow(imported({ glossary: [{ ...term, rulesKind: "character" }] })).glossary,
    [
      {
        id: -1,
        source: "星澜",
        userTranslation: "Xinglan",
        rulesKind: "character",
        userPronoun: "she",
      },
    ],
  );
  assert.deepStrictEqual(
    Result.getOrThrow(imported({ glossary: [{ ...term, rulesKind: "word" }] })).glossary,
    [{ id: -1, source: "星澜", userTranslation: "Xinglan", rulesKind: "word" }],
  );
  const they = { ...term, rulesKind: "character", userPronoun: "they" };
  assert.strictEqual(problem(imported({ glossary: [they] })), "format");
  assert.strictEqual(
    problem(imported({ glossary: [{ ...term, userTranslation: " ", rulesKind: "name" }] })),
    "format",
  );
  const twice = imported({
    glossary: [
      { ...term, rulesKind: "name" },
      { ...term, rulesKind: "word" },
    ],
  });
  assert.strictEqual(problem(twice), "duplicateTerm");
});

it("an imported term keeps the kind and pronoun the rules gave the saved one", () => {
  const saved = testTerm("林雨", { rulesKind: "character", rulesPronoun: "she", sheClues: 3 });
  const into = { ...current, glossary: [saved] };
  const after = Result.getOrThrow(
    imported(
      {
        glossary: [
          { source: "林雨", rulesKind: "word", modelKind: "character", modelPronoun: "he" },
        ],
      },
      into,
    ),
  );
  assert.deepStrictEqual(after.glossary, [
    { ...saved, modelKind: "character", modelPronoun: "he" },
  ]);
});

it("a renamed glossary term renames the texts that are exactly that term", () => {
  const rain = newEntry({ _tag: "EventName", map: 1, event: 2 }, "雨");
  const named = testCatalog({
    entries: [{ ...rain, userTranslation: "Rain" }],
    glossary: [testTerm("雨", { userTranslation: "Rain", rulesKind: "name" })],
  });
  const after = Result.getOrThrow(
    imported(
      { texts: [], glossary: [{ source: "雨", userTranslation: "Drizzle", rulesKind: "name" }] },
      named,
    ),
  );
  assert.deepStrictEqual(inUse(after), ["Drizzle"]);
});

it("imported image text replaces the saved results of its images, keeping the runs they name", () => {
  const reader = {
    detection: "det",
    recognition: "rec",
    inpainting: "inpaint",
    includeFaint: false,
  };
  const saved: ImageReadResults = {
    version: 1,
    images: {
      "img/a/One": { ...result("One.png"), run: "old" },
      "img/a/Two": { ...result("Two.png"), run: "replaced" },
    },
    runs: { old: reader, replaced: reader },
  };
  const erased = new Map([["two.png", new Uint8Array([1, 2, 3])]]);
  const merged = importedImageText(saved, {
    results: {
      version: 1,
      images: { "img/a/Two": { ...result("Two-new.png"), run: "new" } },
      runs: { new: reader },
    },
    erased,
  });
  assert.deepStrictEqual(merged.results.images, {
    "img/a/One": { ...result("One.png"), run: "old" },
    "img/a/Two": { ...result("Two-new.png"), run: "new" },
  });
  assert.deepStrictEqual(merged.results.runs, { old: reader, new: reader });
  assert.strictEqual(merged.erased, erased);
});

it("a translation file carries each erased background as its patches", () => {
  const images = {
    "img/a/One": { file: "One.png", sha256: "s", width: 1, height: 1, lines: [], erased: "x.png" },
  };
  assert.strictEqual(problem(decodeTranslationFile({ ...exported, images })), "format");
});

it("an import keeps the game's translation switch and fixes that are off, whatever the file says", () => {
  const off = testCatalog({
    entries: [greeting],
    settings: { isTranslationOn: false, disabledFixes: ["copy.rb"] },
  });
  const saved = Result.getOrThrow(
    imported({ settings: { isTranslationOn: true, disabledFixes: [] } }, off),
  );
  assert.isFalse(saved.settings.isTranslationOn);
  assert.deepStrictEqual(saved.settings.disabledFixes, ["copy.rb"]);
});

it("an import preview counts the translations and glossary terms that change, and the images read before", () => {
  const before = {
    ...current,
    glossary: [
      testTerm("雨村", { userTranslation: "Rainville", rulesKind: "name" }),
      testTerm("晴", { userTranslation: "Sunny", rulesKind: "character" }),
    ],
  };
  const file = Result.getOrThrow(
    decodeTranslationFile({
      ...exported,
      texts: [greetingText({ userTranslation: "Hello \\N[1]!" }), labelText()],
      glossary: [
        { source: "雨村", userTranslation: "Rainhold", rulesKind: "name" },
        { source: "风", userTranslation: "Wind", rulesKind: "word" },
      ],
    }),
  );
  const image = { sha256: "s", width: 1, height: 1, lines: [] };
  const withImages = { ...file, images: { "img/a/One": image, "img/a/Two": image } };
  const savedImages: ImageReadResults = {
    version: 1,
    images: { "img/a/One": result("One.png") },
    runs: {},
  };
  const after = Result.getOrThrow(importTranslations(before, file));
  assert.deepStrictEqual(importPreview(before, after, savedImages, withImages), {
    translations: { inFile: 1, added: 1, changed: 0, cleared: 1, notInGame: 0 },
    glossary: { inFile: 2, added: 1, changed: 1, removed: 1 },
    images: { inFile: 2, replaced: 1 },
  });
});
