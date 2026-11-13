import type { Engine } from "@rpgtl/contracts";

/** What RPGTL can do with a game besides translating its text. */
export interface EngineFeatures {
  /** Playing it in the browser and in NW.js, with the game scripts. */
  readonly play: boolean;
  /** Reading and translating the text in its images. */
  readonly imageText: boolean;
  /** Finding text in its data that no entry covers, and translated text its logic compares. */
  readonly coverage: boolean;
}

const all: EngineFeatures = { play: true, imageText: true, coverage: true };

/** What RPGTL can do with a game of each engine; the page shows only these. */
export const engineFeatures: Record<Engine, EngineFeatures> = {
  MV: all,
  MZ: all,
  XP: { play: false, imageText: false, coverage: false },
};
