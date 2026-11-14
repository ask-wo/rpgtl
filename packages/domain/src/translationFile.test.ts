import { assert, it } from "@effect/vitest";
import type { Catalog, ImageReadResults } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import {
  decodeTranslationFile,
  entryTranslation,
  importedImageText,
  importPreview,
  importTranslations,
  newEntry,
} from "./index.ts";

const greeting = newEntry(
  { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 }, index: 0 },
  "你好 \\N[1]!",
);
const label = newEntry(
  { _tag: "ImageLines", image: "img/menus/main/commands/Recalled", lines: [0] },
  "鉴赏",
);
const current: Catalog = {
  version: 1,
  game: { id: "g", title: "G", engine: "MZ" },
  translate: true,
  entries: [
    greeting,
    { ...label, translation: { guess: { value: "View", run: "r", long: "Appreciate" } } },
  ],
  glossary: [],
};

const imported = (file: object) =>
  decodeTranslationFile({ ...current, ...file }).pipe(
    Result.flatMap((decoded) => importTranslations(current, decoded)),
  );
const problem = (result: Result.Result<unknown, { readonly problem: string }>) =>
  Result.isFailure(result) ? result.failure.problem : undefined;
const user = (translation: string) => (translation ? { user: translation } : {});
const translated = (translation: string) =>
  Result.getOrThrow(
    imported({
      entries: [{ ...greeting, translation: user(translation), path: ["__proto__"], file: "../x" }],
    }),
  ).entries[0];

it("an import takes translations by entry id, from the same game in any folder, keeping each entry's place and control codes", () => {
  assert.deepStrictEqual(translated("Hello \\N[1]!"), {
    ...greeting,
    translation: { user: "Hello \\N[1]!" },
  });
  assert.strictEqual(
    problem(imported({ entries: [{ ...greeting, translation: { user: "Hello!" } }] })),
    "controlCodes",
  );
  assert.strictEqual(problem(imported({ entries: [greeting, greeting] })), "duplicateEntry");
  assert.strictEqual(
    problem(imported({ entries: [{ ...greeting, keepOriginal: true }] })),
    "keepOriginal",
  );
  assert.strictEqual(problem(imported({ entries: [{ ...greeting, id: "other" }] })), "otherGame");
  assert.isUndefined(problem(imported({ game: { id: "moved", title: "G", engine: "MZ" } })));
  assert.strictEqual(Result.getOrThrow(imported({ language: "korean" })).language, "korean");
});

it("a translation file from a newer RPGTL is turned down as newer, not as damaged", () => {
  assert.strictEqual(problem(imported({ version: 2, entries: "changed" })), "newer");
  assert.strictEqual(problem(imported({ version: 1, entries: "changed" })), "format");
});

it("an import takes an image's corrected text with its English, and the text read undoes it", () => {
  const corrected = { ...label, source: "欣赏", readerText: "鉴赏", translation: user("Gallery") };
  const after = Result.getOrThrow(imported({ entries: [corrected] }));
  assert.deepStrictEqual(after.entries[1], corrected);
  const back = Result.getOrThrow(
    importTranslations(
      after,
      Result.getOrThrow(decodeTranslationFile({ ...current, entries: [label] })),
    ),
  );
  assert.deepStrictEqual(back.entries[1], { ...label, previous: "Gallery" });
  const misplaced = Result.getOrThrow(
    imported({
      entries: [
        { ...greeting, source: "你好", readerText: greeting.source, translation: user("Hi") },
      ],
    }),
  );
  assert.deepStrictEqual(misplaced.entries[0], { ...greeting, translation: {} });
});

const labelAfter = (translation: string) =>
  Result.getOrThrow(imported({ entries: [{ ...label, translation: user(translation) }] }))
    .entries[1]?.translation;
const glossary = (...terms: ReadonlyArray<object>) => imported({ glossary: terms });
const result = (file: string) => ({ file, sha256: "s", width: 1, height: 1, lines: [] });

it("an import from another version of the game takes the entries it still has and leaves out the rest", () => {
  const file = Result.getOrThrow(
    decodeTranslationFile({
      ...current,
      entries: [
        { ...greeting, translation: { user: "Hello \\N[1]!" } },
        { ...greeting, id: "gone", source: "再见", translation: user("Bye!") },
        { ...label, source: "鉴赏 2", translation: user("View 2") },
      ],
    }),
  );
  const after = Result.getOrThrow(importTranslations(current, file));
  assert.deepStrictEqual(after.entries.map(entryTranslation), ["Hello \\N[1]!", "View"]);
  assert.deepStrictEqual(
    importPreview(current, after, { version: 1, images: {}, runs: {} }, file).translations,
    {
      inFile: 3,
      added: 1,
      changed: 0,
      cleared: 0,
      notInGame: 2,
    },
  );
});

const line = (index: number, source: string) =>
  newEntry(
    { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 }, index },
    source,
  );

it("a line that moved in another version of the game takes the English of the same Chinese, unless the file gives that Chinese different English", () => {
  const moved = line(5, "走吧");
  const twice = line(6, "好");
  const version: Catalog = { ...current, entries: [greeting, moved, twice] };
  const file = Result.getOrThrow(
    decodeTranslationFile({
      ...version,
      entries: [
        { ...greeting, translation: { user: "Hello \\N[1]!" } },
        { ...line(4, "走吧"), translation: user("Let's go") },
        { ...line(2, "好"), translation: user("OK") },
        { ...line(3, "好"), translation: user("Fine") },
        { ...line(1, "再见"), translation: user("Bye") },
      ],
    }),
  );
  const after = Result.getOrThrow(importTranslations(version, file));
  assert.deepStrictEqual(after.entries.map(entryTranslation), ["Hello \\N[1]!", "Let's go", ""]);
  assert.strictEqual(
    importPreview(version, after, { version: 1, images: {}, runs: {} }, file).translations
      .notInGame,
    3,
  );
});

it("English a file gives without a guess is the user's, beside the saved entry's guess", () => {
  const guess = { value: "View", run: "r", long: "Appreciate" };
  assert.deepStrictEqual(labelAfter("Appreciate"), { guess, user: "Appreciate" });
  assert.deepStrictEqual(labelAfter(""), {});
});

const kind = (value: string) => ({ guess: { value } });

it("an imported glossary has trimmed terms listed once, and only characters keep a pronoun", () => {
  const term = { source: " 星澜 ", translation: { user: "Xinglan " }, pronoun: { user: "she" } };
  assert.deepStrictEqual(
    Result.getOrThrow(glossary({ ...term, kind: kind("character") })).glossary,
    [
      {
        source: "星澜",
        translation: { user: "Xinglan" },
        kind: { guess: { value: "character" } },
        pronoun: { user: "she" },
      },
    ],
  );
  assert.deepStrictEqual(Result.getOrThrow(glossary({ ...term, kind: kind("word") })).glossary, [
    { source: "星澜", translation: { user: "Xinglan" }, kind: { guess: { value: "word" } } },
  ]);
  const they = { ...term, kind: kind("character"), pronoun: { user: "they" } };
  assert.strictEqual(problem(glossary(they)), "format");
  assert.strictEqual(
    problem(glossary({ ...term, translation: { user: " " }, kind: kind("name") })),
    "format",
  );
  const twice = glossary({ ...term, kind: kind("name") }, { ...term, kind: kind("word") });
  assert.strictEqual(problem(twice), "duplicateTerm");
});

it("a renamed glossary term renames the entries that are exactly that term", () => {
  const rain = newEntry({ _tag: "EventName", map: 1, event: 2 }, "雨");
  const named: Catalog = {
    ...current,
    entries: [{ ...rain, translation: { user: "Rain" } }],
    glossary: [{ source: "雨", translation: { user: "Rain" }, kind: { guess: { value: "name" } } }],
  };
  const file = Result.getOrThrow(
    decodeTranslationFile({
      ...named,
      glossary: [
        { source: "雨", translation: { user: "Drizzle" }, kind: { guess: { value: "name" } } },
      ],
    }),
  );
  const [renamed] = Result.getOrThrow(importTranslations(named, file)).entries;
  assert.strictEqual(renamed && entryTranslation(renamed), "Drizzle");
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
  const file = { ...current, images };
  assert.strictEqual(problem(decodeTranslationFile(file)), "format");
});

it("an import keeps the game's translation switch and fixes that are off, whatever the file says", () => {
  assert.isTrue(Result.getOrThrow(imported({ translate: false })).translate);
  const off = { ...current, translate: false, disabledFixes: ["copy.rb"] };
  const file = Result.getOrThrow(decodeTranslationFile({ ...current, translate: true }));
  const saved = Result.getOrThrow(importTranslations(off, file));
  assert.isFalse(saved.translate);
  assert.deepStrictEqual(saved.disabledFixes, ["copy.rb"]);
});

const codex = {
  translator: "codex",
  model: "gpt-6.1-terra",
  glossaryModel: "gpt-6.1-sol",
} as const;
const made = (run: string) => ({
  ...greeting,
  translation: { guess: { value: "Hello \\N[1]!", run } },
});

it("an import keeps a run's guess when the file describes the run, and makes other English the user's", () => {
  const fromRun = Result.getOrThrow(
    imported({ entries: [made("r")], translationRuns: { r: { ...codex, guesses: 1 } } }),
  );
  assert.deepStrictEqual(fromRun.entries[0], made("r"));
  assert.deepStrictEqual(fromRun.runs, { r: codex });

  const saved: Catalog = { ...current, entries: [made("r")], runs: { r: codex } };
  // A guess changed in the exported file, or of a run the file doesn't describe, is the user's.
  for (const file of [
    {
      entries: [
        { ...greeting, translation: { guess: { value: "Hi \\N[1]!", run: "unknown run" } } },
      ],
    },
    {
      entries: [{ ...greeting, translation: { guess: { value: "Hi \\N[1]!", run: "r" } } }],
      translationRuns: { r: codex },
    },
  ]) {
    const changed = decodeTranslationFile({ ...current, ...file }).pipe(
      Result.flatMap((decoded) => importTranslations(saved, decoded)),
    );
    assert.deepStrictEqual(Result.getOrThrow(changed).entries[0], {
      ...made("r"),
      translation: { ...made("r").translation, user: "Hi \\N[1]!" },
    });
  }
});

it("an imported term keeps its guesses the same way, and the file's own values stay the user's", () => {
  const term = {
    source: "林雨",
    translation: { guess: { value: "Lin Yu", run: "r" } },
    kind: { guess: { value: "character", run: "r" } },
    pronoun: { guess: { value: "she", run: "r", she: 1, he: 4 }, user: "she" },
  } as const;
  const fromRun = Result.getOrThrow(imported({ glossary: [term], translationRuns: { r: codex } }));
  assert.deepStrictEqual(fromRun.glossary, [term]);
  assert.deepStrictEqual(fromRun.runs, { r: codex });

  const saved: Catalog = { ...current, glossary: [term], runs: { r: codex } };
  const edited = { ...term, translation: { guess: { value: "Lin Rain", run: "r" } } };
  const changed = decodeTranslationFile({
    ...current,
    glossary: [edited],
    translationRuns: { r: codex },
  }).pipe(Result.flatMap((decoded) => importTranslations(saved, decoded)));
  assert.deepStrictEqual(Result.getOrThrow(changed).glossary, [
    { ...term, translation: { ...term.translation, user: "Lin Rain" } },
  ]);
});

it("an import preview counts the translations and glossary terms that change, and the images read before", () => {
  const before: Catalog = {
    ...current,
    glossary: [
      { source: "雨村", translation: { user: "Rainville" }, kind: { guess: { value: "name" } } },
      { source: "晴", translation: { user: "Sunny" }, kind: { guess: { value: "character" } } },
    ],
  };
  const file = Result.getOrThrow(
    decodeTranslationFile({
      ...before,
      entries: [
        { ...greeting, translation: { user: "Hello \\N[1]!" } },
        { ...label, translation: {} },
      ],
      glossary: [
        { source: "雨村", translation: { user: "Rainhold" }, kind: { guess: { value: "name" } } },
        { source: "风", translation: { user: "Wind" }, kind: { guess: { value: "word" } } },
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
