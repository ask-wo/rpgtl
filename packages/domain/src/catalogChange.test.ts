import { catalogChange, withCatalogChange, withTexts } from "./index.ts";
import { assert, it } from "@effect/vitest";
import type { Catalog } from "@rpgtl/contracts";
import { testCatalog, testTerm } from "./testUtils/catalog.ts";

const entry = (id: string, source: string) =>
  ({
    id,
    location: {
      _tag: "CommandText",
      list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
      index: 0,
      parameter: 0,
      keys: ["0"],
    },
    source,
  }) as const;
const catalog = testCatalog({
  entries: [entry("a", "你好"), entry("b", "再见"), entry("c", "早上好")],
});

/** The catalog with the user's English for the texts of the sources given. */
const translated = (from: Catalog, english: Readonly<Record<string, string>>) =>
  withTexts(from, (text) => {
    const userTranslation = english[text.source];
    return userTranslation === undefined ? text : { ...text, userTranslation };
  });

it("a change to some texts sends only those, with what the checks find in their entries", () => {
  const first = catalogChange(undefined, catalog);
  assert.strictEqual(first.change._tag, "whole");
  const next = translated(catalog, { 你好: "Hello 你", 早上好: "Morning." });
  const { checked, change } = catalogChange(first.checked, next);
  assert.strictEqual(change._tag, "texts");
  if (change._tag !== "texts") return;
  assert.deepStrictEqual(
    change.texts.map(({ source }) => source),
    ["你好", "早上好"],
  );
  assert.deepStrictEqual(Object.keys(change.findings), ["a"]);
  assert.deepStrictEqual(withCatalogChange(first.checked, change), checked);
});

it("a text fixed since the last change loses its entries' findings", () => {
  const flagged = translated(catalog, { 你好: "Hello 你" });
  const first = catalogChange(undefined, flagged);
  assert.deepStrictEqual(Object.keys(first.checked.findings), ["a"]);
  const { checked, change } = catalogChange(first.checked, translated(flagged, { 你好: "Hello." }));
  assert.deepStrictEqual(checked.findings, {});
  assert.deepStrictEqual(withCatalogChange(first.checked, change)?.findings, {});
});

it("other entries send the whole catalog again", () => {
  const first = catalogChange(undefined, catalog);
  const fewer = { ...catalog, entries: catalog.entries.slice(1) };
  assert.strictEqual(catalogChange(first.checked, fewer).change._tag, "whole");
});

it("a changed glossary checks every entry again, but sends only the changed texts", () => {
  const town = testCatalog({ entries: [entry("a", "小镇你好"), entry("b", "再见")] });
  const first = catalogChange(undefined, translated(town, { 小镇你好: "Hello." }));
  assert.deepStrictEqual(first.checked.findings, {});
  const { change } = catalogChange(first.checked, {
    ...first.checked.catalog,
    glossary: [testTerm("小镇", { userTranslation: "Elmford", rulesKind: "name" })],
  });
  assert.strictEqual(change._tag, "texts");
  if (change._tag !== "texts") return;
  assert.deepStrictEqual(change.texts, []);
  assert.deepStrictEqual(change.findings, {
    a: [{ check: "glossary name missing", detail: "小镇 → Elmford" }],
  });
});

it("a change of the game's language checks every entry again", () => {
  const shop = testCatalog({
    entries: [entry("a", "他の店に行こう。"), entry("b", "再见")],
    settings: { sourceLanguage: "chinese" },
  });
  const flagged = translated(shop, { "他の店に行こう。": "She goes to another shop." });
  const first = catalogChange(undefined, flagged);
  assert.deepStrictEqual(Object.keys(first.checked.findings), ["a"]);
  const { checked } = catalogChange(first.checked, {
    ...flagged,
    settings: { ...flagged.settings, sourceLanguage: "japanese" },
  });
  assert.deepStrictEqual(checked.findings, {});
});
