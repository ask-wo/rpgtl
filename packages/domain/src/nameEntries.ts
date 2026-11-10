import type { Entry } from "@rpgtl/contracts";
import * as Option from "effect/Option";
import { controlCodePattern } from "./controlCodes.ts";
import { entryLocation } from "./location.ts";

type Located = Pick<Entry, "file" | "path" | "source">;

const databaseNames = /^(Classes|Skills|Items|Weapons|Armors|Enemies|States)\.json$/;
const systemLists = ["elements", "skillTypes", "weaponTypes", "armorTypes", "equipTypes"];

const systemNames = new Set(["basic", "commands", "params"]);

/**
 * Whether an entry is a name or label from the database, System.json (the game's title included) or
 * a map's display name. The glossary pass translates these on the glossary model.
 */
export function isNameEntry(entry: Located) {
  if (entry.source.includes("\n") || entry.source.match(controlCodePattern)) return false;
  if (isActorName(entry)) return true;
  return Option.exists(entryLocation(entry), (location) => {
    if (location._tag === "RecordField")
      return databaseNames.test(entry.file) && location.field === "name";
    if (location._tag === "MapName") return true;
    if (location._tag !== "SystemText") return false;
    const [first, second = ""] = location.keys;
    return (
      first === "gameTitle" ||
      systemLists.some((key) => first === key) ||
      (first === "terms" && systemNames.has(second))
    );
  });
}

/** An actor's name or nickname in Actors.json. */
export const isActorName = (entry: Pick<Entry, "file" | "path">) =>
  entry.file === "Actors.json" &&
  Option.exists(
    entryLocation(entry),
    (location) =>
      location._tag === "RecordField" &&
      (location.field === "name" || location.field === "nickname"),
  );

/** The speaker name of an MZ Show Text (its parameter 4). */
export const isSpeakerNameEntry = (entry: Pick<Entry, "file" | "path">) =>
  Option.exists(
    entryLocation(entry),
    (location) =>
      location._tag === "CommandText" && location.parameter === 4 && location.keys.length === 0,
  );
