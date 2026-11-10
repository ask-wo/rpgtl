import type { Catalog, Entry, Findings } from "@rpgtl/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { entryTranslation, isUserValue } from "@rpgtl/domain";

export const Area = Schema.Literals(["Maps", "Database", "System", "Plugins"]);
export type Area = typeof Area.Type;
export const areas = Area.literals;

export const Shown = Schema.Literals(["all", "untranslated", "failed", "last-run", "flagged"]);
export type Shown = typeof Shown.Type;

/** What the Text page shows, kept in its address: a file or an area, a search and a filter. */
export const TextSearch = Schema.Struct({
  file: Schema.optionalKey(Schema.String),
  area: Schema.optionalKey(Area),
  q: Schema.optionalKey(Schema.String),
  show: Schema.optionalKey(Shown),
});
export type TextSearch = typeof TextSearch.Type;

/** The address's search, or none of it when part of it doesn't fit. */
export const textSearch = (search: unknown): TextSearch =>
  Option.getOrElse(Schema.decodeUnknownOption(TextSearch)(search), () => ({}));

/** The search with `change` made, leaving out what is empty. */
export const changedSearch = (
  search: TextSearch,
  change: { readonly [K in keyof TextSearch]?: TextSearch[K] | undefined },
): TextSearch => {
  const { file, area, q, show } = { ...search, ...change };
  return {
    ...(file !== undefined && { file }),
    ...(area !== undefined && { area }),
    ...(q !== undefined && q !== "" && { q }),
    ...(show !== undefined && show !== "all" && { show }),
  };
};

/** Which area of the tree a data file's text is in; image text is on the Images page. */
export const areaOf = (file: string): Area | undefined =>
  file.startsWith("img/")
    ? undefined
    : /^Map\d+\.json$/.test(file)
      ? "Maps"
      : file === "System.json"
        ? "System"
        : file.endsWith(".js")
          ? "Plugins"
          : "Database";

/** The game's text that the Text page edits: everything but the text in images. */
export const textEntries = (catalog: Catalog) =>
  catalog.entries.filter((entry) => areaOf(entry.file) !== undefined);

/** Each map file's name from the game's map list, in English once translated. */
export const mapNames = (catalog: Catalog) =>
  new Map(
    catalog.entries.flatMap((entry) => {
      const [id, field] = entry.path;
      return entry.file === "MapInfos.json" && field === "name" && entry.path.length === 2
        ? [[`Map${id?.padStart(3, "0")}.json`, entryTranslation(entry) || entry.source] as const]
        : [];
    }),
  );

/** Why an accepted translation is worth a look: its run's flag and what the checks found. */
export const checkNotes = (entry: Entry, findings: Findings) =>
  [
    isUserValue(entry.translation) ? undefined : entry.translation.guess?.flag,
    ...(findings[entry.id] ?? []).map(({ check, detail }) =>
      detail ? `${check} (${detail})` : check,
    ),
  ].filter((note): note is string => note !== undefined && note !== "");

/** What a filter needs to know beyond the entry itself. */
export interface ShownContext {
  /** The entries the game's last run couldn't translate. */
  readonly failed: ReadonlySet<string>;
  readonly lastRun: string | undefined;
  readonly findings: Findings;
}

export const isShown = (entry: Entry, show: Shown, context: ShownContext) => {
  switch (show) {
    case "all":
      return true;
    case "untranslated":
      return !entryTranslation(entry);
    case "failed":
      return context.failed.has(entry.id) || (!entryTranslation(entry) && !!entry.suggestion);
    case "last-run":
      return context.lastRun !== undefined && entry.translation.guess?.run === context.lastRun;
    case "flagged":
      return !!entryTranslation(entry) && checkNotes(entry, context.findings).length > 0;
  }
};

/** Whether the entry's original or English holds the search, ignoring case. */
export const matches = (entry: Entry, query: string) =>
  !query ||
  entry.source.toLowerCase().includes(query) ||
  entryTranslation(entry).toLowerCase().includes(query);
