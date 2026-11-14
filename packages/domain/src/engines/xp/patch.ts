import { strToU8, zipSync } from "fflate";

/** The archive `Game.exe` loads before any loose file of the same name. */
export const xpArchiveName = "Game.rgssad";

/**
 * The name Unpack gives the archive, so `Game.exe` plays the loose files while RPGTL still reads
 * the game's own data from it.
 */
export const xpUnpackedArchiveName = "Game.rgssad.original";

const readmeName = "English patch.txt";

const readme = (title: string) =>
  `English patch for ${title}, made with RPGTL.

1. If the game folder has a file named ${xpArchiveName}, the game loads most of its files from it
   instead of from this patch. Extract the files in it into the game folder with a tool such as
   RPGMakerDecrypter (https://github.com/uuksu/RPGMakerDecrypter), so that a Data folder appears
   next to Game.exe. Then rename ${xpArchiveName} to ${xpUnpackedArchiveName}.
2. Only after step 1, copy this patch's Data folder, and its Graphics folder if it has one,
   into the game folder, replacing the files there. Extracting the archive afterwards would put
   the original files back over the patch.
   If the game has no ${xpArchiveName}, keep a copy of its Data folder first: the patch replaces
   its original text.
3. Start Game.exe.

Images or sounds with Japanese or Chinese file names may not load on a computer set to another
language. Starting Game.exe with Locale Emulator usually fixes that.
`;

/**
 * The patch Export writes for an XP game: its translated data files by name, in a `Data/` folder
 * to copy over the game's own, the files that draw English into its images by path below the
 * game's folder, and a readme of the steps.
 */
export const xpPatchZip = (
  title: string,
  files: ReadonlyMap<string, Uint8Array>,
  graphics: ReadonlyMap<string, Uint8Array>,
) =>
  zipSync({
    [readmeName]: strToU8(readme(title).replaceAll("\n", "\r\n")),
    Data: Object.fromEntries(files),
    ...Object.fromEntries(graphics),
  });
