/** Run start times as they appear in file names, with `:` and `.` as `-`. */
export const fileTime = (iso: string) => iso.replace(/[:.]/g, "-");

/**
 * A game's files in the state folder, relative to it. All of them are in `games/<game id>/`,
 * except the game's line in `games.json`.
 */
export const gameFiles = (id: string) => {
  const folder = `games/${id}`;
  return {
    folder,
    catalog: `${folder}/catalog.json`,
    /** Earlier catalogs, which each catalog change copies here first. */
    backups: `${folder}/backups`,
    /** What the image reader found, by image path. */
    imageResults: `${folder}/images.json`,
    /** The erased backgrounds of the game's image text, named by their content. */
    erasedImages: `${folder}/images`,
    /** The entries `pnpm run compare` translates, kept so later comparisons use the same text. */
    samples: `${folder}/samples.json`,
    playtime: `${folder}/playtime.json`,
    reports: `${folder}/reports`,
    logs: `${folder}/logs`,
    /** The folder NW.js opens, with its `package.json` pointing at the game's index.html. */
    nwjsApp: `${folder}/nwjs`,
    nwjsHook: `${folder}/nwjs-hook.js`,
  };
};
