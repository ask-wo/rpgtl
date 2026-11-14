import { strToU8, zipSync } from "fflate";

/** The archive `Game.exe` loads before any loose file of the same name. */
export const xpArchiveName = "Game.rgssad";

/**
 * The name Unpack gives the archive, so `Game.exe` plays the loose files while RPGTL still reads
 * the game's own data from it.
 */
export const xpUnpackedArchiveName = "Game.rgssad.original";

const readmeName = "English patch.txt";

const fixesNote = (fixes: ReadonlyArray<string>) =>
  fixes.length === 0
    ? ""
    : `
Its scripts also include these fixes for bugs in the game itself:
${fixes.map((name) => `- ${name}\n`).join("")}`;

const readme = (title: string, fixes: ReadonlyArray<string>) =>
  `English patch for ${title}, machine-translated using RPGTL (https://github.com/ask-wo/rpgtl).

1. If the game folder already has a file named ${xpArchiveName}, the game prefers its files over
   this patch. Extract ${xpArchiveName} into the game folder with a tool such as
   RPGMakerDecrypter (https://github.com/uuksu/RPGMakerDecrypter), so that a Data folder appears
   next to Game.exe. Then rename ${xpArchiveName} to ${xpUnpackedArchiveName}.
2. Only after step 1, copy this patch's Data folder, and its Graphics folder if it has one,
   into the game folder, replacing the files there.
   If the game has no ${xpArchiveName}, make a backup of its Data folder first, since the
   patch would overwrite files in it.
3. Start Game.exe.

Images or sounds with Japanese or Chinese file names may not load on a computer set to another
language. Starting Game.exe with e.g. Locale Emulator usually fixes that.
${fixesNote(fixes)}`;

/**
 * The patch Export writes for an XP game: its translated data files by name, in a `Data/` folder
 * to copy over the game's own, the files that draw English into its images by path below the
 * game's folder, and a readme of the steps that names the fixes in its scripts.
 */
export const xpPatchZip = (
  title: string,
  files: ReadonlyMap<string, Uint8Array>,
  graphics: ReadonlyMap<string, Uint8Array>,
  fixes: ReadonlyArray<string>,
) =>
  zipSync({
    [readmeName]: strToU8(readme(title, fixes).replaceAll("\n", "\r\n")),
    Data: Object.fromEntries(files),
    ...Object.fromEntries(graphics),
  });
