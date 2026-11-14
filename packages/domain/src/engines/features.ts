import type { Engine } from "@rpgtl/contracts";

/** What RPGTL can do with a game besides translating its text. */
export interface EngineFeatures {
  /** Starting it with Play: MV and MZ games in NW.js, XP games in mkxp-z. */
  readonly play: boolean;
  /** Playing it in the browser, and the game scripts' tools: the F8 panel, map view and cheats. */
  readonly gameScripts: boolean;
  /** Reading and translating the text in its images. */
  readonly imageText: boolean;
  /** Finding text in its data that no entry covers, and translated text its logic compares. */
  readonly coverage: boolean;
  /** Exporting a patch for the game's own player, and unpacking its archive for that patch. */
  readonly patch: boolean;
}

const all: EngineFeatures = {
  play: true,
  gameScripts: true,
  imageText: true,
  coverage: true,
  patch: false,
};

/** What RPGTL can do with a game of each engine; the page shows only these. */
export const engineFeatures: Record<Engine, EngineFeatures> = {
  MV: all,
  MZ: all,
  XP: { play: true, gameScripts: false, imageText: true, coverage: false, patch: true },
};
