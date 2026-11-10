import type { Entry, EntryTranslation } from "@rpgtl/contracts";
import * as Option from "effect/Option";
import { entryTranslation, isUserValue } from "./guesses.ts";
import { entryLocation, Location, pathOf } from "./location.ts";

const pathKey = (file: string, path: ReadonlyArray<string>) => JSON.stringify([file, path]);

type Located = Pick<Entry, "source"> & Partial<Pick<Entry, "file" | "path" | "speaker">>;

/**
 * Looks up the MZ Show Text speaker (parameter 4), or the speaker extracted from a dialogue picture.
 */
export function showTextSpeakers<E extends Located>(entries: ReadonlyArray<E>) {
  const byPath = new Map<string, E>();
  for (const entry of entries)
    if (entry.file !== undefined && entry.path) byPath.set(pathKey(entry.file, entry.path), entry);
  return (entry: E): string | undefined => {
    const location = entryLocation(entry);
    if (
      entry.file === undefined ||
      Option.isNone(location) ||
      !("list" in location.value && "index" in location.value)
    )
      return entry.speaker;
    const { list, index } = location.value;
    const speaker = Location.CommandText({ list, index: index - 1, parameter: 4, keys: [] });
    return byPath.get(pathKey(entry.file, pathOf(speaker)))?.source ?? entry.speaker;
  };
}

/**
 * Matches entries by exact source and speaker. Text drawn in images matches only text drawn in
 * images, since its English has to fit the room there, and a label shortened for a button doesn't
 * belong in the rest of the game.
 */
export function reuseKeys<E extends Located>(entries: ReadonlyArray<E>) {
  const speakerOf = showTextSpeakers(entries);
  return (entry: E) =>
    JSON.stringify([
      entry.source,
      speakerOf(entry) ?? null,
      entry.file?.startsWith("img/") ?? false,
    ]);
}

type ReusedGuess = NonNullable<EntryTranslation["guess"]>;

/**
 * Fills untranslated entries with the English of entries with the same reuse key, in place, as a
 * guess of the run that started at `run`, dropping the answer a run rejected for them and the
 * English they had before when it is that English again.
 */
export function translationReuse<
  E extends Pick<Entry, "source"> & {
    translation: EntryTranslation;
    suggestion?: Entry["suggestion"];
    previous?: string;
  } & Partial<Pick<Entry, "file" | "path">>,
>(entries: ReadonlyArray<E>, run?: string) {
  const keyOf = reuseKeys(entries);
  const keys = new Map(entries.map((entry) => [entry, keyOf(entry)]));
  const byKey = new Map<string, E[]>();
  const asGuess = (entry: E): ReusedGuess | undefined => {
    const value = entryTranslation(entry);
    if (!value) return undefined;
    const { guess } = entry.translation;
    return guess && !isUserValue(entry.translation)
      ? guess
      : { value, ...(run !== undefined && { run }) };
  };
  // When existing copies disagree, the first translated one in catalog order wins.
  const guesses = new Map<string, ReusedGuess>();
  for (const [entry, key] of keys) {
    const copies = byKey.get(key);
    if (copies) copies.push(entry);
    else byKey.set(key, [entry]);
    const value = entryTranslation(entry);
    if (value && !guesses.has(key)) guesses.set(key, { value, ...(run !== undefined && { run }) });
  }
  const fill = (key: string) => {
    const guess = guesses.get(key);
    if (guess === undefined) return [];
    const filled = (byKey.get(key) ?? []).filter((entry) => !entryTranslation(entry));
    for (const entry of filled) {
      entry.translation = { guess };
      delete entry.suggestion;
      if (entry.previous === guess.value) delete entry.previous;
    }
    return filled;
  };
  return {
    /** Fills every untranslated entry whose key has English. Returns the filled entries. */
    fillAll: () => [...guesses.keys()].flatMap(fill),
    /** The English already used for this entry's key, if any. Entries not passed in have none. */
    known(entry: E) {
      const key = keys.get(entry);
      return key === undefined ? undefined : guesses.get(key)?.value;
    },
    /**
     * Records the entry's English for its key and fills the untranslated copies with its guess,
     * flag and all; returns them.
     */
    spread(entry: E) {
      const key = keys.get(entry);
      const guess = asGuess(entry);
      if (key === undefined || !guess) return [];
      if (!guesses.has(key)) guesses.set(key, guess);
      return fill(key);
    },
  };
}
