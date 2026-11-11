import type { Playtime } from "@rpgtl/contracts";

/** The playtime with `seconds` more, played until `now`, an ISO time. */
export const addPlaytime = (
  saved: Playtime | undefined,
  seconds: number,
  now: string,
): Playtime => ({ seconds: (saved?.seconds ?? 0) + seconds, lastPlayed: now });
