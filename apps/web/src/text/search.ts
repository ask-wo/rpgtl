import type { Catalog, Entry, Findings, Table } from "@rpgtl/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { entryTranslation, isImageText, isUserValue, Place } from "@rpgtl/domain";

export const Area = Schema.Literals(["Maps", "Database", "System", "Plugins"]);
export type Area = typeof Area.Type;
export const areas = Area.literals;

export const Shown = Schema.Literals(["all", "untranslated", "failed", "last-run", "flagged"]);
export type Shown = typeof Shown.Type;

/** What the Text page shows, kept in its address: a place or an area, a search and a filter. */
export const TextSearch = Schema.Struct({
  place: Schema.optionalKey(Schema.String),
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
  const { place, area, q, show } = { ...search, ...change };
  return {
    ...(place !== undefined && { place }),
    ...(area !== undefined && { area }),
    ...(q !== undefined && q !== "" && { q }),
    ...(show !== undefined && show !== "all" && { show }),
  };
};

/** Which area of the tree a place's text is in; image text is on the Images page. */
export const areaOf = (place: Place): Area | undefined => {
  switch (place._tag) {
    case "Map":
      return "Maps";
    case "System":
      return "System";
    case "Plugins":
      return "Plugins";
    case "Image":
      return undefined;
    case "Table":
    case "CommonEvents":
    case "Troops":
      return "Database";
  }
};

/** The game's text that the Text page edits: everything but the text in images. */
export const textEntries = (catalog: Catalog) =>
  catalog.entries.filter((entry) => !isImageText(entry));

/** Each map's name from the game's map list, in English once translated, by map id. */
export const mapNames = (catalog: Catalog) =>
  new Map(
    catalog.entries.flatMap((entry) =>
      entry.location._tag === "RecordField" &&
      entry.location.table === "mapInfos" &&
      entry.location.field === "name"
        ? [[entry.location.record, entryTranslation(entry) || entry.source] as const]
        : [],
    ),
  );

const tableLabels: Record<Table, string> = {
  actors: "Actors",
  classes: "Classes",
  skills: "Skills",
  items: "Items",
  weapons: "Weapons",
  armors: "Armors",
  enemies: "Enemies",
  states: "States",
  mapInfos: "Map list",
  tilesets: "Tilesets",
};

/** How the tree and the entries name a place: a map by its number and name. */
export const placeLabel = (place: Place, maps: ReadonlyMap<number, string>) =>
  Place.$match(place, {
    Map: ({ map }) => {
      const name = maps.get(map);
      const number = `Map${String(map).padStart(3, "0")}`;
      return name ? `${number} · ${name}` : number;
    },
    Table: ({ table }) => tableLabels[table],
    CommonEvents: () => "Common events",
    Troops: () => "Troops",
    System: () => "System",
    Plugins: () => "Plugin settings",
    Image: ({ image }) => image,
  });

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
