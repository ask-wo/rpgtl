import type { ReadEntry } from "./catalog.ts";
import { listKey, type Placed } from "./location.ts";
import { isSpeakerNameEntry } from "./nameEntries.ts";

type Located = Pick<ReadEntry, "source"> & Partial<Pick<ReadEntry, "speaker">> & Placed;

/**
 * Looks up the MZ Show Text speaker (parameter 4), or the speaker extracted from a dialogue picture.
 * A text's key holds the speaker, so text that reads the same but is said by other people gets
 * English of its own.
 */
export function showTextSpeakers<E extends Located>(entries: ReadonlyArray<E>) {
  const byCommand = new Map<string, E>();
  for (const entry of entries)
    if (isSpeakerNameEntry(entry) && entry.location?._tag === "CommandText")
      byCommand.set(`${listKey(entry.location.list)} ${entry.location.index}`, entry);
  return (entry: E): string | undefined => {
    const { location } = entry;
    if (location === undefined || !("list" in location)) return entry.speaker;
    const key = `${listKey(location.list)} ${location.index - 1}`;
    return byCommand.get(key)?.source ?? entry.speaker;
  };
}
