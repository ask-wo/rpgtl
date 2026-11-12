import {
  CommonEvents,
  GameMap,
  GameRecords,
  GameSystem,
  Plugins,
  type Table,
  Troops,
} from "@rpgtl/contracts";
import * as Data from "effect/Data";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { mapOf, tableOf } from "./location.ts";

/** A data file of a game, by what RPGTL reads in it. */
export type GameFile = Data.TaggedEnum<{
  Map: { readonly map: number; readonly data: GameMap };
  CommonEvents: { readonly data: CommonEvents };
  Troops: { readonly data: Troops };
  System: { readonly data: GameSystem };
  /** Actors.json, Items.json and the other files whose records have names and descriptions. */
  Database: { readonly table: Exclude<Table, "tilesets">; readonly data: GameRecords };
  /** Tilesets.json, whose records have notes but no text the player sees. */
  Tilesets: { readonly data: GameRecords };
  /** A file with no text RPGTL translates, such as Animations.json or a plugin's own data. */
  Other: { readonly data: unknown };
}>;
export const GameFile = Data.taggedEnum<GameFile>();

/** A game file whose content isn't what its name says it is. */
export class GameFileInvalid extends Schema.TaggedError<GameFileInvalid>()("GameFileInvalid", {
  file: Schema.String,
  problem: Schema.String,
}) {
  override get message() {
    return `${this.file} can't be read: ${this.problem}`;
  }
}

const decode = <S extends Schema.Decoder<unknown>>(
  schema: S,
  file: string,
  text: string,
): Result.Result<S["Type"], GameFileInvalid> =>
  Schema.decodeResult(Schema.fromJsonString(schema))(text).pipe(
    Result.mapError((error) => new GameFileInvalid({ file, problem: error.message })),
  );

/** Reads a file of the game's data folder, such as `Map001.json`, from its text. */
export function decodeGameFile(
  file: string,
  text: string,
): Result.Result<GameFile, GameFileInvalid> {
  const map = mapOf(file);
  if (map !== undefined)
    return Result.map(decode(GameMap, file, text), (data) => GameFile.Map({ map, data }));
  if (file === "CommonEvents.json")
    return Result.map(decode(CommonEvents, file, text), (data) => GameFile.CommonEvents({ data }));
  if (file === "Troops.json")
    return Result.map(decode(Troops, file, text), (data) => GameFile.Troops({ data }));
  if (file === "System.json")
    return Result.map(decode(GameSystem, file, text), (data) => GameFile.System({ data }));
  const table = tableOf(file);
  if (table === "tilesets")
    return Result.map(decode(GameRecords, file, text), (data) => GameFile.Tilesets({ data }));
  if (table !== undefined)
    return Result.map(decode(GameRecords, file, text), (data) =>
      GameFile.Database({ table, data }),
    );
  return Result.map(decode(Schema.Unknown, file, text), (data) => GameFile.Other({ data }));
}

/** Reads the `$plugins` list from the text of js/plugins.js. */
export const decodePlugins = (text: string) =>
  decode(Plugins, "js/plugins.js", text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));

/** The text of js/plugins.js for a plugin list. */
export const encodePlugins = (plugins: Plugins) => `var $plugins =\n${JSON.stringify(plugins)};\n`;
