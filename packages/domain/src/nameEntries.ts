import type { Entry, Table } from "@rpgtl/contracts";
import type { Placed } from "./location.ts";
import { controlCodePattern } from "./controlCodes.ts";

type Located = Pick<Entry, "source"> & Placed;

const databaseNames = new Set<Table>([
  "classes",
  "skills",
  "items",
  "weapons",
  "armors",
  "enemies",
  "states",
]);
const systemLists = ["elements", "skillTypes", "weaponTypes", "armorTypes", "equipTypes"];

const systemNames = new Set(["basic", "commands", "params"]);

/**
 * Whether an entry is a name or label from the database, System.json (the game's title included) or
 * a map's display name. The glossary pass translates these on the glossary model.
 */
export function isNameEntry(entry: Located) {
  if (entry.source.includes("\n") || entry.source.match(controlCodePattern)) return false;
  if (isActorName(entry)) return true;
  const { location } = entry;
  if (location === undefined) return false;
  if (location._tag === "RecordField")
    return databaseNames.has(location.table) && location.field === "name";
  if (location._tag === "MapName") return true;
  if (location._tag !== "SystemText") return false;
  const [first, second = ""] = location.keys;
  return (
    first === "gameTitle" ||
    systemLists.some((key) => first === key) ||
    (first === "terms" && systemNames.has(second))
  );
}

/** An actor's name or nickname in Actors.json. */
export const isActorName = ({ location }: Placed) =>
  location?._tag === "RecordField" &&
  location.table === "actors" &&
  (location.field === "name" || location.field === "nickname");

/** The speaker name of an MZ Show Text (its parameter 4). */
export const isSpeakerNameEntry = ({ location }: Placed) =>
  location?._tag === "CommandText" && location.parameter === 4 && location.keys.length === 0;
