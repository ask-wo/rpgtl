import type { Catalog, CatalogChange, Entry, Findings } from "@rpgtl/contracts";
import { catalogFindings, translationChecks } from "./checks.ts";
import { entryTranslation } from "./guesses.ts";
import { gameLanguage } from "./language.ts";

/** A catalog with what the checks find in it. */
export interface CheckedCatalog {
  readonly catalog: Catalog;
  readonly findings: Findings;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * `next` with its findings, and how it differs from `previous`: only the changed entries when
 * `next` has the same entries in the same order, as after a run's batch or an edit, otherwise the
 * whole catalog. The checks run again only on the changed entries while the glossary and the
 * language stay the same, as they depend on them.
 */
export function catalogChange(
  previous: CheckedCatalog | undefined,
  next: Catalog,
): { readonly checked: CheckedCatalog; readonly change: CatalogChange } {
  const before = previous?.catalog.entries ?? [];
  if (
    previous === undefined ||
    before.length !== next.entries.length ||
    next.entries.some((entry, index) => entry.id !== before[index]?.id)
  ) {
    const findings = catalogFindings(next);
    return {
      checked: { catalog: next, findings },
      change: { _tag: "whole", catalog: next, findings },
    };
  }
  const changed: Entry[] = next.entries.filter((entry, index) => !same(entry, before[index]));
  const findings =
    same(previous.catalog.glossary, next.glossary) && previous.catalog.language === next.language
      ? withChecked(
          previous.findings,
          changed,
          translationChecks(next.glossary, gameLanguage(next), next.game.engine),
        )
      : catalogFindings(next);
  const { entries: _, ...rest } = next;
  return {
    checked: { catalog: next, findings },
    change: { _tag: "entries", catalog: rest, entries: changed, findings },
  };
}

const withChecked = (
  findings: Findings,
  entries: ReadonlyArray<Entry>,
  check: ReturnType<typeof translationChecks>,
): Findings => {
  const all: Record<string, Findings[string]> = { ...findings };
  for (const entry of entries) {
    delete all[entry.id];
    const found = check(entry, entryTranslation(entry));
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
  const changed = new Map(change.entries.map((entry) => [entry.id, entry]));
  return {
    catalog: {
      ...change.catalog,
      entries: previous.catalog.entries.map((entry) => changed.get(entry.id) ?? entry),
    },
    findings: change.findings,
  };
}
