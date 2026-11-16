import type { Catalog, CatalogChange, Findings, Text } from "@rpgtl/contracts";
import { type EntryText, entryTexts, textsById } from "./catalog.ts";
import { catalogFindings, translationChecks } from "./checks.ts";
import { translationInUse } from "./inUse.ts";
import { gameLanguage } from "./language.ts";

/** A catalog with what the checks find in it. */
export interface CheckedCatalog {
  readonly catalog: Catalog;
  readonly findings: Findings;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * `next` with its findings, and how it differs from `previous`: only the changed texts when `next`
 * has the same entries, as after a run's batch or an edit, otherwise the whole catalog. The checks
 * run again only on the entries of changed texts while the glossary and the language stay the
 * same, as they depend on them.
 */
export function catalogChange(
  previous: CheckedCatalog | undefined,
  next: Catalog,
): { readonly checked: CheckedCatalog; readonly change: CatalogChange } {
  const before = previous?.catalog.entries ?? [];
  if (
    previous === undefined ||
    before.length !== next.entries.length ||
    next.entries.some((entry, index) => {
      const old = before[index];
      return (
        entry !== old &&
        (entry.id !== old?.id ||
          entry.textId !== old.textId ||
          entry.isLeftUntranslated !== old.isLeftUntranslated)
      );
    })
  ) {
    const findings = catalogFindings(next);
    return {
      checked: { catalog: next, findings },
      change: { _tag: "whole", catalog: next, findings },
    };
  }
  const old = textsById(previous.catalog);
  const texts: Text[] = next.texts.filter((text) => !same(text, old.get(text.id)));
  const changed = new Set(texts.map((text) => text.id));
  const findings =
    same(previous.catalog.glossary, next.glossary) &&
    gameLanguage(previous.catalog) === gameLanguage(next)
      ? withChecked(
          previous.findings,
          entryTexts(next).filter((entry) => changed.has(entry.textId)),
          translationChecks(next.glossary, gameLanguage(next), next.game.engine),
        )
      : catalogFindings(next);
  const { entries: _, texts: __, ...rest } = next;
  return {
    checked: { catalog: next, findings },
    change: { _tag: "texts", catalog: rest, texts, findings },
  };
}

const withChecked = (
  findings: Findings,
  entries: ReadonlyArray<EntryText>,
  check: ReturnType<typeof translationChecks>,
): Findings => {
  const all: Record<string, Findings[string]> = { ...findings };
  for (const entry of entries) {
    delete all[entry.id];
    const found = check(entry, translationInUse(entry));
    if (found.length) all[entry.id] = found;
  }
  return all;
};

/** `previous` with `change` applied, as the page keeps the catalog it follows. */
export function withCatalogChange(
  previous: CheckedCatalog | undefined,
  change: CatalogChange,
): CheckedCatalog | undefined {
  if (change._tag === "whole") return { catalog: change.catalog, findings: change.findings };
  if (previous === undefined) return undefined;
  const changed = new Map(change.texts.map((text) => [text.id, text]));
  const known = new Set(previous.catalog.texts.map((text) => text.id));
  return {
    catalog: {
      ...change.catalog,
      // Kept when it is the same, so a page of a large glossary doesn't draw it again on each save.
      glossary: same(previous.catalog.glossary, change.catalog.glossary)
        ? previous.catalog.glossary
        : change.catalog.glossary,
      entries: previous.catalog.entries,
      texts: [
        ...previous.catalog.texts.map((text) => changed.get(text.id) ?? text),
        ...change.texts.filter((text) => !known.has(text.id)),
      ],
    },
    findings: change.findings,
  };
}
