import { CommonEvents, GameMap, GameRecords, GameSystem, Troops } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { GameFile, GameFileInvalid } from "../mvmz/gameFile.ts";
import { readData } from "./data.ts";
import { decodeXpScripts } from "./scripts.ts";
import { xpMapOf, xpTableOf } from "./location.ts";

const decode = <S extends Schema.Decoder<unknown>>(schema: S, file: string, data: unknown) =>
  Schema.decodeUnknownResult(schema)(data).pipe(
    Result.mapError((error) => new GameFileInvalid({ file, problem: error.message })),
  );

/** The file of an XP game's `Data/` folder that holds its Ruby scripts. */
export const scriptsFile = "Scripts.rxdata";

/** Reads a file of an XP game's `Data/` folder, such as `Map001.rxdata`, from its bytes. */
export function decodeXpFile(
  file: string,
  bytes: Uint8Array,
): Result.Result<GameFile, GameFileInvalid> {
  if (file === scriptsFile) return decodeXpScripts(file, bytes);
  return Result.flatMap(readData(file, bytes), (data): Result.Result<GameFile, GameFileInvalid> => {
    const map = xpMapOf(file);
    if (map !== undefined)
      return Result.map(decode(GameMap, file, data), (map_) => GameFile.Map({ map, data: map_ }));
    if (file === "CommonEvents.rxdata")
      return Result.map(decode(CommonEvents, file, data), (events) =>
        GameFile.CommonEvents({ data: events }),
      );
    if (file === "Troops.rxdata")
      return Result.map(decode(Troops, file, data), (troops) => GameFile.Troops({ data: troops }));
    if (file === "System.rxdata")
      return Result.map(decode(GameSystem, file, data), (system) =>
        GameFile.System({ data: system }),
      );
    const table = xpTableOf(file);
    if (table === "tilesets")
      return Result.map(decode(GameRecords, file, data), (records) =>
        GameFile.Tilesets({ data: records }),
      );
    if (table !== undefined)
      return Result.map(decode(GameRecords, file, data), (records) =>
        GameFile.Database({ table, data: records }),
      );
    return Result.succeed(GameFile.Other({ data }));
  });
}
