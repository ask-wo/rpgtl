import { assert, it } from "@effect/vitest";
import {
  lastRun,
  newEntry,
  restoredCatalog,
  withTextOf,
  withTranslationsCleared,
} from "./index.ts";
import { testCatalog, testTerm } from "./testUtils/catalog.ts";

const line = (index: number, source: string) =>
  newEntry(
    { _tag: "Message", list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 }, index },
    source,
  );

it("clearing every translation keeps the English it had and leaves the switch on", () => {
  const catalog = testCatalog({
    entries: [{ ...line(1, "客人"), userTranslation: "Guest", rejectedTranslation: "Guests" }],
    settings: { isTranslationOn: true },
  });
  const cleared = restoredCatalog(catalog);
  assert.deepStrictEqual(cleared.texts, [
    { id: 1, source: "客人", isInImage: false, previousTranslation: "Guest" },
  ]);
  assert.isTrue(cleared.settings.isTranslationOn);
});

it("clearing a line's translation clears its text for every line of it, but keeps the user's", () => {
  const catalog = testCatalog({
    entries: [
      { ...line(1, "你好"), modelTranslation: "Hello", modelOperationId: 1 },
      line(2, "你好"),
      { ...line(3, "再见"), userTranslation: "Bye" },
    ],
  });
  const { cleared, catalog: after } = withTranslationsCleared(catalog, [
    line(2, "你好").id,
    line(3, "再见").id,
  ]);
  assert.strictEqual(cleared, 1);
  assert.deepStrictEqual(after.texts, [
    { id: 1, source: "你好", isInImage: false, previousTranslation: "Hello" },
    { id: 2, source: "再见", isInImage: false, userTranslation: "Bye" },
  ]);
});

it("a text that isn't saved yet gets an id below 0 once, and a saved one keeps its own", () => {
  const catalog = testCatalog({ entries: [line(1, "你好")] });
  const saved = withTextOf(catalog, { source: "你好", isInImage: false });
  assert.strictEqual(saved.id, 1);
  assert.strictEqual(saved.catalog, catalog);
  const added = withTextOf(catalog, { source: "你好", isInImage: true });
  assert.strictEqual(added.id, -1);
  assert.strictEqual(withTextOf(added.catalog, { source: "你好", isInImage: true }).id, -1);
  assert.strictEqual(withTextOf(added.catalog, { source: "再见", isInImage: true }).id, -2);
});

it("the last run is the latest run whose model translation a text or a term still has", () => {
  const catalog = testCatalog({
    entries: [
      { ...line(1, "你好"), modelTranslation: "Hello", modelOperationId: 2 },
      { ...line(2, "再见"), modelTranslation: "Bye", modelOperationId: 3 },
    ],
    operations: [
      { id: 2, kind: "run", startedAt: "2026-10-01T00:00:00.000Z" },
      { id: 3, kind: "import", startedAt: "2026-10-02T00:00:00.000Z" },
      { id: 4, kind: "run", startedAt: "2026-10-03T00:00:00.000Z" },
    ],
  });
  assert.strictEqual(lastRun(catalog), 2);
  const named = {
    ...catalog,
    glossary: [testTerm("雨", { modelTranslation: "Rain", modelOperationId: 4 })],
  };
  assert.strictEqual(lastRun(named), 4);
  assert.isUndefined(lastRun(testCatalog()));
});
