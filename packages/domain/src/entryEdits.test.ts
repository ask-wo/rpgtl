import { assert, it } from "@effect/vitest";
import type { Catalog } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import { newEntry, withEntryEdits } from "./index.ts";

const line = (index: number, source: string, translation: string) => ({
  ...newEntry(
    { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 }, index: index },
    source,
  ),
  translation: translation ? { user: translation } : {},
});
const run = "2026-11-04T10:00:00.000Z";
const hello = {
  ...newEntry(
    { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 }, index: 0 },
    "你好",
  ),
  translation: { guess: { value: "Hello", run, flag: "Check the tone" } },
};
const bye = {
  ...line(1, "再见", ""),
  suggestion: { text: "再见 bye", reason: "source text left" },
};
const arlene = line(2, "\\N[1]来了", "\\N[1] is here");
const catalog: Catalog = {
  version: 1,
  game: { id: "g", title: "G", engine: "MZ" },
  translate: true,
  entries: [hello, bye, arlene],
  glossary: [],
};

it("English other than the run's is the user's, beside the run's guess, and the guess's own English restores it", () => {
  const saved = Result.getOrThrow(
    withEntryEdits(catalog, [
      { id: hello.id, translation: "Hi" },
      { id: arlene.id, translation: "\\N[1] is here" },
    ]),
  );
  assert.deepStrictEqual(saved.entries[0]?.translation, { ...hello.translation, user: "Hi" });
  assert.strictEqual(saved.entries[1], bye);
  assert.strictEqual(saved.entries[2], arlene);
  assert.strictEqual(saved.translate, true);
  const restored = Result.getOrThrow(
    withEntryEdits(saved, [{ id: hello.id, translation: "Hello" }]),
  );
  assert.deepStrictEqual(restored.entries[0], hello);
});

it("a rejected answer stays until the entry has English typed, and clearing keeps the old English", () => {
  const typed = Result.getOrThrow(withEntryEdits(catalog, [{ id: bye.id, translation: "Bye" }]));
  assert.deepStrictEqual(typed.entries[1], line(1, "再见", "Bye"));
  const cleared = Result.getOrThrow(withEntryEdits(typed, [{ id: bye.id, translation: "" }]));
  assert.deepStrictEqual(cleared.entries[1], { ...line(1, "再见", ""), previous: "Bye" });
});

it("an edit that drops a control code, or names an entry the catalog lacks, saves nothing", () => {
  const dropped = withEntryEdits(catalog, [{ id: arlene.id, translation: "Arlene is here" }]);
  assert.strictEqual(Result.isFailure(dropped) && dropped.failure.problem, "controlCodes");
  const unknown = withEntryEdits(catalog, [{ id: "gone", translation: "Hi" }]);
  assert.strictEqual(Result.isFailure(unknown) && unknown.failure.problem, "unknownEntry");
});

it("an image text keeps or drops its original artwork without touching its English", () => {
  const title = {
    ...newEntry({ _tag: "ImageLines", image: "img/pictures/Title", lines: [0] }, "标题"),
    translation: { guess: { value: "Title", run } },
  };
  const images = { ...catalog, entries: [title] };
  const kept = Result.getOrThrow(withEntryEdits(images, [{ id: title.id, keepOriginal: true }]));
  assert.deepStrictEqual(kept.entries[0], { ...title, keepOriginal: true });
  const both = Result.getOrThrow(
    withEntryEdits(kept, [{ id: title.id, keepOriginal: false, translation: "Name" }]),
  );
  assert.deepStrictEqual(both.entries[0], {
    ...title,
    translation: { ...title.translation, user: "Name" },
  });
});

it("a corrected image text drops the run's English for the old text, keeps the user's, and the text read restores it", () => {
  const start = {
    ...newEntry({ _tag: "ImageLines", image: "img/pictures/Title", lines: [0] }, "开使"),
    translation: { guess: { value: "Open", run } },
    suggestion: { text: "开使 open", reason: "source text left" },
  };
  const quit = {
    ...newEntry({ _tag: "ImageLines", image: "img/pictures/Title", lines: [1] }, "退山"),
    translation: { guess: { value: "Retreat mountain", run }, user: "Quit" },
  };
  const images = { ...catalog, entries: [...catalog.entries, start, quit] };
  const fixed = Result.getOrThrow(
    withEntryEdits(images, [
      { id: start.id, text: " 开始 " },
      { id: quit.id, text: "退出" },
    ]),
  );
  assert.deepStrictEqual(fixed.entries.slice(3), [
    {
      id: start.id,
      location: start.location,
      source: "开始",
      readerText: "开使",
      translation: {},
      previous: "Open",
    },
    { ...quit, source: "退出", readerText: "退山", translation: { user: "Quit" } },
  ]);
  const back = Result.getOrThrow(withEntryEdits(fixed, [{ id: start.id, text: "开使" }]));
  assert.deepStrictEqual(back.entries[3], {
    id: start.id,
    location: start.location,
    source: "开使",
    translation: {},
    previous: "Open",
  });

  const problem = (edit: { id: string; text: string; translation?: string }) => {
    const result = withEntryEdits(images, [edit]);
    return Result.isFailure(result) ? result.failure.problem : undefined;
  };
  assert.strictEqual(problem({ id: start.id, text: " " }), "emptyText");
  assert.strictEqual(problem({ id: hello.id, text: "你好啊" }), "notImageText");
  assert.strictEqual(
    problem({ id: start.id, text: "\\V[1]开始", translation: "Start" }),
    "controlCodes",
  );
  assert.isUndefined(problem({ id: start.id, text: "\\V[1]开始", translation: "\\V[1] Start" }));
});
