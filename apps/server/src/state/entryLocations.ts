import { gameFiles } from "@rpgtl/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { StateFolder } from "./StateFolder.ts";

// The step's own copy of what format 1 stored and format 2 stores, so it doesn't follow the
// contracts as they change after it.
const OldEntry = Schema.StructWithRest(
  Schema.Struct({
    file: Schema.optionalKey(Schema.String),
    path: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const SavedCatalog = Schema.StructWithRest(Schema.Struct({ entries: Schema.Array(OldEntry) }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);

type Value = { readonly [key: string]: Value } | ReadonlyArray<Value> | string | number;

const tables: Record<string, string> = {
  "Actors.json": "actors",
  "Classes.json": "classes",
  "Skills.json": "skills",
  "Items.json": "items",
  "Weapons.json": "weapons",
  "Armors.json": "armors",
  "Enemies.json": "enemies",
  "States.json": "states",
  "MapInfos.json": "mapInfos",
  "Tilesets.json": "tilesets",
};

const number = (key: string | undefined) =>
  key !== undefined && /^\d+$/.test(key) ? Number(key) : undefined;

// Format 2 names a map by its number, and the engine loads map n only from this name.
const mapOf = (file: string) => {
  const map = number(/^Map(\d+)\.json$/.exec(file)?.[1]);
  return map !== undefined && `Map${String(map).padStart(3, "0")}.json` === file ? map : undefined;
};

function listOf(file: string, keys: ReadonlyArray<string>): Value | undefined {
  const [first, second, third, fourth] = keys.map(number);
  if (file === "CommonEvents.json" && keys.length === 2 && first !== undefined)
    return { _tag: "CommonEvent", event: first };
  if (file === "Troops.json" && keys.length === 4 && keys[1] === "pages")
    return first === undefined || third === undefined
      ? undefined
      : { _tag: "TroopPage", troop: first, page: third };
  const map = mapOf(file);
  if (map !== undefined && keys.length === 5 && keys[0] === "events" && keys[2] === "pages")
    return second === undefined || fourth === undefined
      ? undefined
      : { _tag: "MapEventPage", map, event: second, page: fourth };
  return undefined;
}

function commandLocation(file: string, path: ReadonlyArray<string>, listEnd: number) {
  const [position, parameters, at, ...rest] = path.slice(listEnd + 1);
  const list = listOf(file, path.slice(0, listEnd + 1));
  const index = number(position);
  const parameter = number(at);
  if (parameters !== "parameters" || !list || index === undefined || parameter === undefined)
    return undefined;
  if (rest[0] === "variableText") {
    const literal = number(rest[1]);
    return rest.length === 2 && literal !== undefined
      ? { _tag: "ScriptText", list, index, parameter, literal }
      : undefined;
  }
  return parameter === 0 && rest.length === 0
    ? { _tag: "Message", list, index }
    : { _tag: "CommandText", list, index, parameter, keys: rest };
}

function noteOwner(file: string, keys: ReadonlyArray<string>): Value | undefined {
  const map = mapOf(file);
  const [first, second, third] = keys.map(number);
  if (map !== undefined) {
    if (keys.length === 0) return { _tag: "Map", map };
    return keys.length === 2 && keys[0] === "events" && second !== undefined
      ? { _tag: "MapEvent", map, event: second }
      : undefined;
  }
  const table = tables[file];
  if (table === undefined || first === undefined) return undefined;
  if (keys.length === 1) return { _tag: "Record", table, record: first };
  return keys.length === 3 && keys[1] === "learnings" && table === "classes" && third !== undefined
    ? { _tag: "ClassLearning", record: first, learning: third }
    : undefined;
}

/** The location an entry of format 1 names with its file and path, or none for one RPGTL never wrote. */
export function locationFrom(file: string, path: ReadonlyArray<string>): Value | undefined {
  if (file.startsWith("img/")) {
    const [lines, ...indices] = path;
    const numbers = indices.flatMap((index) => number(index) ?? []);
    return lines === "lines" && numbers.length === indices.length
      ? { _tag: "ImageLines", image: file, lines: numbers }
      : undefined;
  }
  if (file === "plugins.js") {
    const [plugin, ...keys] = path;
    return plugin === undefined ? undefined : { _tag: "PluginSetting", plugin, keys };
  }
  const note = path.length - 3;
  if (path[note] === "note" && path[note + 1] === "noteText") {
    const owner = noteOwner(file, path.slice(0, note));
    const tag = number(path[note + 2]);
    return owner && tag !== undefined ? { _tag: "NoteTag", owner, tag } : undefined;
  }
  const list = path.indexOf("list");
  if (list >= 0) return commandLocation(file, path, list);
  const [first, second, third] = path;
  if (file === "System.json") {
    const id = number(second);
    if (path.length === 2 && (first === "switches" || first === "variables"))
      return id === undefined ? undefined : { _tag: "Name", group: first, id };
    return path.length ? { _tag: "SystemText", keys: path } : undefined;
  }
  const map = mapOf(file);
  if (map !== undefined) {
    if (path.length === 1 && first === "displayName") return { _tag: "MapName", map };
    const event = number(second);
    return path.length === 3 && first === "events" && third === "name" && event !== undefined
      ? { _tag: "EventName", map, event }
      : undefined;
  }
  const table = tables[file];
  const record = number(first);
  return table !== undefined && path.length === 2 && second !== undefined && record !== undefined
    ? { _tag: "RecordField", table, record, field: second }
    : undefined;
}

/**
 * Format 1 to 2: each catalog entry keeps a location in place of its file and path. Entries whose
 * path names no place are dropped, as no translation reached the game from them.
 */
export const entryLocations = Effect.fn("entryLocations")(function* (
  folder: StateFolder["Service"],
) {
  for (const id of yield* folder.list("games")) {
    const file = gameFiles(id).catalog;
    const saved = yield* folder.read(file, SavedCatalog);
    if (Option.isNone(saved)) continue;
    const entries = saved.value.entries.flatMap(({ file: name, path, ...entry }) => {
      if (name === undefined || path === undefined) return [entry];
      const location = locationFrom(name, path);
      return location === undefined ? [] : [{ ...entry, location }];
    });
    yield* folder.write(file, SavedCatalog, { ...saved.value, entries });
  }
});
