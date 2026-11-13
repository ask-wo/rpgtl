import type { Game, GameActivity } from "@rpgtl/contracts";

/** An inspected MV game, as the server lists it. */
export const game: Game = {
  id: "0f1e2d3c4b5a69788796",
  root: "/games/rain",
  webRoot: "/games/rain/www",
  engine: "MV",
  title: "Rain",
  files: [],
  encryptedAssets: false,
  mediaWarnings: [],
  missingImages: [],
};

/** A game's activity with NW.js downloaded and nothing running. */
export const idle: GameActivity = {
  program: {
    name: "NW.js",
    version: "v0.117.0",
    size: 100e6,
    folder: "/home/player/.cache/rpgtl/nwjs",
    phase: { _tag: "Ready" },
    attempt: 0,
  },
  launch: null,
  translation: null,
  images: null,
  importing: null,
};
