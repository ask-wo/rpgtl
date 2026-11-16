import type { Catalog, Findings, Table } from "@rpgtl/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type EntryText,
  entryTexts,
  isImageText,
  isUserTranslation,
  Place,
  translationInUse,
} from "@rpgtl/domain";

export const Area = Schema.Literals(["Maps", "Database", "System", "Plugins", "Scripts"]);
export type Area = typeof Area.Type;
export const areas = Area.literals;

export const Shown = Schema.Literals([
  "all",
  "untranslated",
  "failed",
  "last-run",
  "changed",
  "flagged",
]);
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
    case "Script":
      return "Scripts";
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
  entryTexts(catalog).filter((entry) => !isImageText(entry));

/** Each map's name from the game's map list, in English once translated, by map id. */
export const mapNames = (catalog: Catalog) =>
  new Map(
    entryTexts(catalog).flatMap((entry) =>
      entry.location._tag === "RecordField" &&
      entry.location.table === "mapInfos" &&
      entry.location.field === "name"
        ? [[entry.location.record, translationInUse(entry) || entry.source] as const]
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
    Script: ({ script, name }) => `Script · ${name.trim() || script + 1}`,
  });

/** Why an accepted translation is worth a look: its run's flag and what the checks found. */
export const checkNotes = (entry: EntryText, findings: Findings) =>
  [
    isUserTranslation(entry) ? undefined : entry.flagReason,
    ...(findings[entry.id] ?? []).map(({ check, detail }) =>
      detail ? `${check} (${detail})` : check,
    ),
  ].filter((note): note is string => note !== undefined && note !== "");

/** What a filter needs to know beyond the entry itself. */
export interface ShownContext {
  /** The entries the game's last run couldn't translate. */
  readonly failed: ReadonlySet<string>;
  /** The operation id of the last run that gave a text its English. */
  readonly lastRun: number | undefined;
  readonly findings: Findings;
  /** Whether a run translates an entry, which only then counts as untranslated. */
  readonly translates: (entry: EntryText) => boolean;
}

/** Whether the entry has English other than the one it had before it was cleared. */
const isChanged = (entry: EntryText) =>
  !!translationInUse(entry) && entry.previousTranslation !== undefined;

export const isShown = (entry: EntryText, show: Shown, context: ShownContext) => {
  switch (show) {
    case "all":
      return true;
    case "untranslated":
      return !translationInUse(entry) && context.translates(entry);
    case "failed":
      return (
        context.failed.has(entry.id) || (!translationInUse(entry) && !!entry.rejectedTranslation)
      );
    case "last-run":
      return context.lastRun !== undefined && entry.modelOperationId === context.lastRun;
    case "changed":
      return isChanged(entry);
    case "flagged":
      return !!translationInUse(entry) && checkNotes(entry, context.findings).length > 0;
  }
};

/** Whether the entry's original, English or English from before clearing holds the search, ignoring case. */
export const matches = (entry: EntryText, query: string) =>
  !query ||
  entry.source.toLowerCase().includes(query) ||
  translationInUse(entry).toLowerCase().includes(query) ||
  (entry.previousTranslation ?? "").toLowerCase().includes(query);
