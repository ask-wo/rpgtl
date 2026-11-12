import { assert, it } from "@effect/vitest";
import type { Catalog } from "@rpgtl/contracts";
import { newEntry, restoredCatalog, runsWithCounts, withRunMarks } from "./index.ts";

const entry = newEntry({ _tag: "EventName", map: 1, event: 1 }, "客人");
const catalog = (fields: Partial<Catalog>): Catalog => ({
  version: 1,
  game: { id: "g", title: "G", engine: "MV" },
  entries: [entry],
  glossary: [],
  translate: true,
  ...fields,
});

it("clearing every translation keeps the English it had and leaves the switch on", () => {
  const cleared = restoredCatalog(
    catalog({ entries: [{ ...entry, translation: { user: "Guest" } }] }),
  );
  assert.deepStrictEqual(cleared.entries[0], { ...entry, translation: {}, previous: "Guest" });
  assert.isTrue(cleared.translate);
});

const codex = {
  translator: "codex",
  model: "gpt-6.1-terra",
  glossaryModel: "gpt-6.1-sol",
} as const;
const line = (index: number, source: string) =>
  newEntry(
    { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 }, index },
    source,
  );
const guessed = (value: string, run: string, user?: string) => ({
  guess: { value, run },
  ...(user !== undefined && { user }),
});

it("a run's marks add it to the runs, keep only the runs a guess still names, and make it the last once it translated an entry", () => {
  const [a, b] = [line(1, "你好"), line(2, "再见")];
  const marked = withRunMarks(
    catalog({
      entries: [
        { ...a, translation: guessed("Hello", "new") },
        { ...b, translation: guessed("Bye", "older") },
      ],
      runs: { old: codex, older: codex },
    }),
    { started: "new", models: codex },
  );
  assert.deepStrictEqual(marked.runs, { older: codex, new: codex });
  assert.strictEqual(marked.lastRun, "new");
  const termsOnly = withRunMarks(
    catalog({
      glossary: [
        {
          source: "小白",
          translation: guessed("Xiaobai", "new"),
          kind: { guess: { value: "name" } },
        },
      ],
    }),
    { started: "new", models: codex },
  );
  assert.deepStrictEqual(termsOnly.runs, { new: codex });
  assert.isUndefined(termsOnly.lastRun);
});

it("an export counts each run's guesses still in use, leaving out English that is a line's own text", () => {
  const counts = runsWithCounts(
    catalog({
      entries: [
        { ...line(1, "你好"), translation: guessed("Hello", "r") },
        { ...line(2, "再见"), translation: guessed("Bye", "r") },
        { ...line(3, "谢谢"), translation: guessed("Thanks", "r", "Thanks!") },
        { ...line(5, "……"), translation: guessed("……", "r") },
        { ...line(6, "停"), translation: {} },
      ],
      glossary: [
        {
          source: "林雨",
          translation: guessed("Lin Yu", "r"),
          kind: { guess: { value: "character", run: "r" } },
          pronoun: { guess: { value: "she", run: "r" }, user: "he" },
        },
        {
          source: "小白",
          translation: guessed("Xiaobai", "r", "Snow"),
          kind: { guess: { value: "character" } },
        },
      ],
      runs: { r: codex },
    }),
  );
  assert.deepStrictEqual(counts, { r: { ...codex, guesses: 4 } });
});
