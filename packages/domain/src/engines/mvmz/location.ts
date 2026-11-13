import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { type Entry, EventListRef, Location, NoteOwner, Table } from "@rpgtl/contracts";

const tableFiles: Record<Table, string> = {
  actors: "Actors.json",
  classes: "Classes.json",
  skills: "Skills.json",
  items: "Items.json",
  weapons: "Weapons.json",
  armors: "Armors.json",
  enemies: "Enemies.json",
  states: "States.json",
  mapInfos: "MapInfos.json",
  tilesets: "Tilesets.json",
};
const fileTables = new Map(Table.literals.map((table) => [tableFiles[table], table]));

/** The database table a data file such as `Items.json` holds. */
export const tableOf = (file: string) => fileTables.get(file);

// The engine loads map n from this name only.
const mapFile = (map: number) => `Map${String(map).padStart(3, "0")}.json`;

/** The map a data file such as `Map007.json` holds; none for a name the engine never loads. */
export const mapOf = (file: string) => {
  const map = /^Map(\d+)\.json$/.exec(file)?.[1];
  return map !== undefined && mapFile(Number(map)) === file ? Number(map) : undefined;
};

const listFile = EventListRef.match({
  CommonEvent: () => "CommonEvents.json",
  TroopPage: () => "Troops.json",
  MapEventPage: ({ map }) => mapFile(map),
});

const noteFile = NoteOwner.match({
  Record: ({ table }) => tableFiles[table],
  ClassLearning: () => tableFiles.classes,
  Map: ({ map }) => mapFile(map),
  MapEvent: ({ map }) => mapFile(map),
});

/**
 * The file below the game's `data/` folder that a location is in; `plugins.js` for a plugin
 * setting, and the image's path for its text.
 */
export const fileOf: (location: Location) => string = Location.match({
  Message: ({ list }) => listFile(list),
  CommandText: ({ list }) => listFile(list),
  ScriptText: ({ list }) => listFile(list),
  RecordField: ({ table }) => tableFiles[table],
  NoteTag: ({ owner }) => noteFile(owner),
  SystemText: () => "System.json",
  MapName: ({ map }) => mapFile(map),
  EventName: ({ map }) => mapFile(map),
  Name: () => "System.json",
  PluginSetting: () => "plugins.js",
  ImageLines: ({ image }) => image,
  RubyScriptText: () => "Scripts.rxdata",
});

const listKeys = EventListRef.match({
  CommonEvent: ({ event }) => [String(event), "list"],
  TroopPage: ({ troop, page }) => [String(troop), "pages", String(page), "list"],
  MapEventPage: ({ event, page }) => ["events", String(event), "pages", String(page), "list"],
});

const noteKeys = NoteOwner.match({
  Record: ({ record }) => [String(record)],
  ClassLearning: ({ record, learning }) => [String(record), "learnings", String(learning)],
  Map: () => [],
  MapEvent: ({ event }) => ["events", String(event)],
});

/** The keys to a location's text in its file. */
export const pathOf: (location: Location) => ReadonlyArray<string> = Location.match({
  Message: ({ list, index }) => [...listKeys(list), String(index), "parameters", "0"],
  CommandText: ({ list, index, parameter, keys }) => [
    ...listKeys(list),
    String(index),
    "parameters",
    String(parameter),
    ...keys,
  ],
  ScriptText: ({ list, index, parameter, literal }) => [
    ...listKeys(list),
    String(index),
    "parameters",
    String(parameter),
    "variableText",
    String(literal),
  ],
  RecordField: ({ record, field }) => [String(record), field],
  NoteTag: ({ owner, tag }) => [...noteKeys(owner), "note", "noteText", String(tag)],
  SystemText: ({ keys }) => keys,
  MapName: () => ["displayName"],
  EventName: ({ event }) => ["events", String(event), "name"],
  Name: ({ group, id }) => [group, String(id)],
  PluginSetting: ({ plugin, keys }) => [plugin, ...keys],
  ImageLines: ({ lines }) => ["lines", ...lines.map(String)],
  RubyScriptText: ({ name, literal }) => [name, String(literal)],
});

/**
 * A new entry for the text at `location`. Its id hashes the file, keys and text, so it stays while
 * the text stays where it is, also in another copy of the game.
 */
export const newEntry = <L extends Location>(
  location: L,
  source: string,
): Entry & { readonly location: L } => ({
  id: bytesToHex(
    sha256(utf8ToBytes(JSON.stringify([fileOf(location), pathOf(location), source]))),
  ).slice(0, 24),
  location,
  source,
  translation: {},
});
