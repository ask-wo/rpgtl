import { assert, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { entryTexts, newEntry, withEntryEdits } from "./index.ts";
import { testCatalog } from "./testUtils/catalog.ts";

const line = (index: number, source: string) =>
  newEntry(
    { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 }, index },
    source,
  );
const fromRun = { modelTranslation: "Hello", modelOperationId: 1, flagReason: "Check the tone" };
const hello = line(0, "你好");
const bye = line(1, "再见");
const arlene = line(2, "\\N[1]来了");
const catalog = testCatalog({
  entries: [
    { ...hello, ...fromRun },
    { ...bye, rejectedTranslation: "再见 bye", rejectionReason: "source text left" },
    { ...arlene, userTranslation: "\\N[1] is here" },
  ],
});
const textOf = (saved: typeof catalog, id: string) =>
  entryTexts(saved).find((entry) => entry.id === id);

it("English other than the run's is the user's, beside the run's, and the run's own English restores it", () => {
  const saved = Result.getOrThrow(
    withEntryEdits(catalog, [
      { id: hello.id, userTranslation: "Hi" },
      { id: arlene.id, userTranslation: "\\N[1] is here" },
    ]),
  );
  assert.deepStrictEqual(saved.texts[0], {
    id: 1,
    source: "你好",
    isInImage: false,
    ...fromRun,
    userTranslation: "Hi",
  });
  assert.strictEqual(saved.texts[1], catalog.texts[1]);
  assert.strictEqual(saved.texts[2], catalog.texts[2]);
  const restored = Result.getOrThrow(
    withEntryEdits(saved, [{ id: hello.id, userTranslation: "Hello" }]),
  );
  assert.deepStrictEqual(restored.texts[0], catalog.texts[0]);
});

it("a rejected answer stays until the text has English typed, and clearing keeps the old English", () => {
  const typed = Result.getOrThrow(
    withEntryEdits(catalog, [{ id: bye.id, userTranslation: "Bye" }]),
  );
  assert.deepStrictEqual(typed.texts[1], {
    id: 2,
    source: "再见",
    isInImage: false,
    userTranslation: "Bye",
  });
  const cleared = Result.getOrThrow(withEntryEdits(typed, [{ id: bye.id, userTranslation: "" }]));
  assert.deepStrictEqual(cleared.texts[1], {
    id: 2,
    source: "再见",
    isInImage: false,
    previousTranslation: "Bye",
  });
});

it("an edit that drops a control code, or names an entry the catalog lacks, saves nothing", () => {
  const dropped = withEntryEdits(catalog, [{ id: arlene.id, userTranslation: "Arlene is here" }]);
  assert.strictEqual(Result.isFailure(dropped) && dropped.failure.problem, "controlCodes");
  const unknown = withEntryEdits(catalog, [{ id: "gone", userTranslation: "Hi" }]);
  assert.strictEqual(Result.isFailure(unknown) && unknown.failure.problem, "unknownEntry");
});

it("an image text is left untranslated or not without touching its English", () => {
  const title = newEntry({ _tag: "ImageLines", image: "img/pictures/Title", lines: [0] }, "标题");
  const images = testCatalog({
    entries: [{ ...title, modelTranslation: "Title", modelOperationId: 1 }],
  });
  const kept = Result.getOrThrow(
    withEntryEdits(images, [{ id: title.id, isLeftUntranslated: true }]),
  );
  const [placed] = images.entries;
  if (!placed) throw new Error("one entry expected");
  assert.deepStrictEqual(kept.entries, [{ ...placed, isLeftUntranslated: true }]);
  assert.deepStrictEqual(kept.texts, images.texts);
  const both = Result.getOrThrow(
    withEntryEdits(kept, [{ id: title.id, isLeftUntranslated: false, userTranslation: "Name" }]),
  );
  assert.deepStrictEqual(both.entries, images.entries);
  assert.strictEqual(textOf(both, title.id)?.userTranslation, "Name");
});

it("a corrected image text moves the entry to the text of its new source, with the user's English, and the text read moves it back", () => {
  const start = newEntry({ _tag: "ImageLines", image: "img/pictures/Title", lines: [0] }, "开使");
  const quit = newEntry({ _tag: "ImageLines", image: "img/pictures/Title", lines: [1] }, "退山");
  const images = testCatalog({
    entries: [
      { ...hello, ...fromRun },
      { ...start, modelTranslation: "Open", modelOperationId: 1 },
      {
        ...quit,
        modelTranslation: "Retreat mountain",
        modelOperationId: 1,
        userTranslation: "Quit",
      },
    ],
  });
  const fixed = Result.getOrThrow(
    withEntryEdits(images, [
      { id: start.id, source: " 开始 " },
      { id: quit.id, source: "退出" },
    ]),
  );
  const texts = (saved: typeof images) =>
    [start.id, quit.id].map((id) => {
      const entry = textOf(saved, id);
      return [entry?.source, entry?.userTranslation, entry?.modelTranslation];
    });
  assert.deepStrictEqual(texts(fixed), [
    ["开始", undefined, undefined],
    ["退出", "Quit", undefined],
  ]);
  const back = Result.getOrThrow(withEntryEdits(fixed, [{ id: start.id, source: "开使" }]));
  assert.deepStrictEqual(textOf(back, start.id), {
    ...start,
    textId: 2,
    isInImage: true,
    modelTranslation: "Open",
    modelOperationId: 1,
  });

  const problem = (edit: { id: string; source: string; userTranslation?: string }) => {
    const result = withEntryEdits(images, [edit]);
    return Result.isFailure(result) ? result.failure.problem : undefined;
  };
  assert.strictEqual(problem({ id: start.id, source: " " }), "emptyText");
  assert.strictEqual(problem({ id: hello.id, source: "你好啊" }), "notImageText");
  assert.strictEqual(
    problem({ id: start.id, source: "\\V[1]开始", userTranslation: "Start" }),
    "controlCodes",
  );
  assert.isUndefined(
    problem({ id: start.id, source: "\\V[1]开始", userTranslation: "\\V[1] Start" }),
  );
});
