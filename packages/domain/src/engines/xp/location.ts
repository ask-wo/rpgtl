import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { type Entry, EventListRef, type Location, Table } from "@rpgtl/contracts";

const tableFiles: Record<Table, string> = {
  actors: "Actors.rxdata",
  classes: "Classes.rxdata",
  skills: "Skills.rxdata",
  items: "Items.rxdata",
  weapons: "Weapons.rxdata",
  armors: "Armors.rxdata",
  enemies: "Enemies.rxdata",
  states: "States.rxdata",
  mapInfos: "MapInfos.rxdata",
  tilesets: "Tilesets.rxdata",
};
const fileTables = new Map(Table.literals.map((table) => [tableFiles[table], table]));

/** The database table a data file such as `Items.rxdata` holds. */
export const xpTableOf = (file: string) => fileTables.get(file);

// The engine loads map n from this name only.
const mapFile = (map: number) => `Map${String(map).padStart(3, "0")}.rxdata`;

/** The map a data file such as `Map007.rxdata` holds; none for a name the engine never loads. */
export const xpMapOf = (file: string) => {
  const map = /^Map(\d+)\.rxdata$/.exec(file)?.[1];
  return map !== undefined && mapFile(Number(map)) === file ? Number(map) : undefined;
};

const listFile = EventListRef.match({
  MapEventPage: ({ map }) => mapFile(map),
  CommonEvent: () => "CommonEvents.rxdata",
  TroopPage: () => "Troops.rxdata",
});

/** The data file below `Data/` that holds the text at `location`; none for one XP has no text at. */
export const xpFileOf = (location: Location) => {
  switch (location._tag) {
    case "Message":
    case "CommandText":
    case "ScriptText":
      return listFile(location.list);
    case "RecordField":
      return tableFiles[location.table];
    case "SystemText":
      return "System.rxdata";
    case "RubyScriptText":
      return "Scripts.rxdata";
    default:
      return undefined;
  }
};

/**
 * A new entry for the text at `location` in an XP game. Its id hashes the location and text, so it
 * stays while the text stays where it is, also in another copy of the game.
 */
export const newXpEntry = <L extends Location>(
  location: L,
  source: string,
): Entry & { readonly location: L } => ({
  id: bytesToHex(sha256(utf8ToBytes(JSON.stringify(["XP", location, source])))).slice(0, 24),
  location,
  source,
  translation: {},
});
