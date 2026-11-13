import { load, RubyObject } from "@hyrious/marshal";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { GameFileInvalid } from "../mvmz/gameFile.ts";

const utf8 = new TextDecoder();

const isIndex = (key: string) => /^(?:0|[1-9]\d*)$/.test(key);

/**
 * Ruby data as JSON-like data: an object's `@name` fields become `name`, and a hash whose keys are
 * all ids, such as a map's events, becomes an array with `null` where no id is; so does an empty
 * hash. Objects the engine dumps as bytes (`Table`, `Color`, `Tone`) become `null`, since they
 * hold no text. RGSS1 strings carry no encoding and are read as UTF-8, which RGSS uses.
 */
function plain(value: unknown): unknown {
  if (value instanceof Uint8Array) return utf8.decode(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof RubyObject) {
    if (value.userDefined !== undefined) return null;
    return Object.fromEntries(
      Object.getOwnPropertySymbols(value).flatMap((symbol) => {
        const name = Symbol.keyFor(symbol);
        return name?.startsWith("@") ? [[name.slice(1), plain(Reflect.get(value, symbol))]] : [];
      }),
    );
  }
  if (Predicate.isObject(value)) {
    const entries = Object.entries(value);
    if (entries.every(([key]) => isIndex(key))) {
      const list: unknown[] = Array.from(
        { length: Math.max(-1, ...entries.map(([key]) => Number(key))) + 1 },
        () => null,
      );
      for (const [key, item] of entries) list[Number(key)] = plain(item);
      return list;
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, plain(item)]));
  }
  return value;
}

/** A data file of an XP game, such as `Map001.rxdata`, as JSON-like data. */
export function readData(file: string, bytes: Uint8Array): Result.Result<unknown, GameFileInvalid> {
  return Result.try({
    try: () => plain(load(bytes)),
    catch: (error) => new GameFileInvalid({ file, problem: String(error) }),
  });
}
