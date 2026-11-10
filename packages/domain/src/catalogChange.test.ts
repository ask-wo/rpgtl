import { catalogChange, withCatalogChange } from "./index.ts";
import { assert, it } from "@effect/vitest";
import type { Catalog, Entry } from "@rpgtl/contracts";

const entry = (id: string, source: string, translation = ""): Entry => ({
  id,
  file: "Map001.json",
  path: ["events", id],
  source,
  translation: translation ? { user: translation } : {},
});
const catalog: Catalog = {
  version: 1,
  game: { id: "fixture", title: "小镇", engine: "MZ" },
  entries: [entry("a", "你好"), entry("b", "再见"), entry("c", "早上好")],
  glossary: [],
  translate: true,
};

it("a change to some entries sends only those, with what the checks find in them", () => {
  const first = catalogChange(undefined, catalog);
  assert.strictEqual(first.change._tag, "whole");
  const next = {
    ...catalog,
    entries: [entry("a", "你好", "Hello 你"), entry("b", "再见"), entry("c", "早上好", "Morning.")],
    lastRun: "2026-11-08T07:00:00Z",
  };
  const { checked, change } = catalogChange(first.checked, next);
  assert.strictEqual(change._tag, "entries");
  if (change._tag !== "entries") return;
  assert.deepStrictEqual(
    change.entries.map(({ id }) => id),
    ["a", "c"],
  );
  assert.deepStrictEqual(Object.keys(change.findings), ["a"]);
  assert.strictEqual(change.catalog.lastRun, "2026-11-08T07:00:00Z");
  assert.deepStrictEqual(withCatalogChange(first.checked, change), checked);
});

it("an entry fixed since the last change loses its findings", () => {
  const flagged = {
    ...catalog,
    entries: [entry("a", "你好", "Hello 你"), ...catalog.entries.slice(1)],
  };
  const first = catalogChange(undefined, flagged);
  assert.deepStrictEqual(Object.keys(first.checked.findings), ["a"]);
  const { checked, change } = catalogChange(first.checked, {
    ...flagged,
    entries: [entry("a", "你好", "Hello."), ...catalog.entries.slice(1)],
  });
  assert.deepStrictEqual(checked.findings, {});
  assert.deepStrictEqual(withCatalogChange(first.checked, change)?.findings, {});
});

it("other entries send the whole catalog again", () => {
  const first = catalogChange(undefined, catalog);
  const fewer = { ...catalog, entries: catalog.entries.slice(1) };
  assert.strictEqual(catalogChange(first.checked, fewer).change._tag, "whole");
});

it("a changed glossary checks every entry again, but sends only the changed ones", () => {
  const translated = {
    ...catalog,
    entries: [entry("a", "小镇你好", "Hello."), ...catalog.entries.slice(1)],
  };
  const first = catalogChange(undefined, translated);
  assert.deepStrictEqual(first.checked.findings, {});
  const { change } = catalogChange(first.checked, {
    ...translated,
    glossary: [
      { source: "小镇", translation: { user: "Elmford" }, kind: { guess: { value: "name" } } },
    ],
  });
  assert.strictEqual(change._tag, "entries");
  if (change._tag !== "entries") return;
  assert.deepStrictEqual(change.entries, []);
  assert.deepStrictEqual(change.findings, {
    a: [{ check: "glossary name missing", detail: "小镇 → Elmford" }],
  });
});

it("a change of the game's language checks every entry again", () => {
  const flagged = {
    ...catalog,
    entries: [
      entry("a", "他の店に行こう。", "She goes to another shop."),
      ...catalog.entries.slice(1),
    ],
    language: "chinese" as const,
  };
  const first = catalogChange(undefined, flagged);
  assert.deepStrictEqual(Object.keys(first.checked.findings), ["a"]);
  const { checked } = catalogChange(first.checked, { ...flagged, language: "japanese" });
  assert.deepStrictEqual(checked.findings, {});
});
