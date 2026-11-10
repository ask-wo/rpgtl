import type { Catalog, Engine, Entry, Game, MissingImage } from "@rpgtl/contracts";
import * as Predicate from "effect/Predicate";
import { guessRuns } from "./catalog.ts";
import { entryTranslation } from "./guesses.ts";

/** The script each engine's boot code loads first. */
export const coreScripts: Record<Engine, string> = { MV: "rpg_core.js", MZ: "rmmz_core.js" };

/**
 * The engines the boot code of `index.html` and `js/main.js` may start, most likely first. Some
 * games ship both engines' core files, so the one the boot code loads wins.
 */
export function bootEngines(html: string, main: string): ReadonlyArray<Engine> {
  const boot = html.replace(/<!--[\s\S]*?-->/g, "") + main;
  if (/src\s*=\s*["'][^"']*rpg_core\.js|Utils\.RPGMAKER_NAME\s*=\s*["']MV/i.test(boot))
    return ["MV"];
  if (/rmmz_core\.js/.test(boot)) return ["MZ"];
  return ["MZ", "MV"];
}

/** Audio and video that NW.js can't play, for files given as paths below the web root. */
export const mediaWarnings = (files: ReadonlyArray<string>) => {
  const known = new Set(files);
  return files
    .flatMap((file) => {
      const [, base, extension] = /^(.*)(\.[^./]*)$/.exec(file) ?? [];
      if (base === undefined || extension === undefined) return [];
      if (extension.toLowerCase() === ".m4a")
        return known.has(`${base}.ogg`)
          ? []
          : [`${file} has no .ogg counterpart; NW.js cannot play AAC audio.`];
      if (extension.toLowerCase() === ".mp4")
        return known.has(`${base}.webm`)
          ? []
          : [`${file} has no .webm counterpart; NW.js cannot play H.264 video.`];
      return [];
    })
    .toSorted();
};

/** An image a data file asks for, such as `img/faces/Actor1`. */
export interface ImageReference {
  readonly file: string;
  readonly path: string;
}

// Fields and event command parameters that name an image, and the folder it is in.
const imageFields: Record<string, string> = {
  faceName: "img/faces/",
  characterName: "img/characters/",
};
const imageParameters: Record<number, Record<number, string>> = {
  101: { 0: "img/faces/" }, // Show Text
  322: { 1: "img/characters/", 3: "img/faces/" }, // Change Actor Images
  323: { 1: "img/characters/" }, // Change Vehicle Image
  231: { 1: "img/pictures/" }, // Show Picture
  41: { 0: "img/characters/" }, // Change Image in a move route
};

/** The images the data of `file` asks for. */
export function imageReferences(file: string, data: unknown): ReadonlyArray<ImageReference> {
  const references: ImageReference[] = [];
  const walk = (node: unknown) => {
    if (!Predicate.isObjectOrArray(node)) return;
    if (
      Predicate.hasProperty(node, "code") &&
      Predicate.isNumber(node.code) &&
      Predicate.hasProperty(node, "parameters") &&
      Array.isArray(node.parameters)
    ) {
      const parameters: ReadonlyArray<unknown> = node.parameters;
      for (const [index, folder] of Object.entries(imageParameters[node.code] ?? {})) {
        const name = parameters[Number(index)];
        if (Predicate.isString(name) && name) references.push({ file, path: folder + name });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      const folder = imageFields[key];
      if (Predicate.isString(value) && value && folder)
        references.push({ file, path: folder + value });
      else walk(value);
    }
  };
  walk(data);
  return references;
}

const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

/** The folders, such as `img/faces/`, that the references are in. */
export const referencedFolders = (references: ReadonlyArray<ImageReference>) => [
  ...new Set(references.map(({ path }) => folderOf(path))),
];

const imageExtension = /\.(?:png|rpgmvp|png_)$/i;

/** The image names in a folder without extension, from the folder's file names. */
export const imageNames = (files: ReadonlyArray<string>) =>
  [
    ...new Set(
      files
        .filter((file) => imageExtension.test(file))
        .map((file) => file.replace(imageExtension, "")),
    ),
  ].toSorted();

/**
 * The images the references ask for that no file in `folders` (image names by folder) is. A file
 * whose name differs only in case is found by both play modes, so it isn't missing.
 */
export function missingImages(
  references: ReadonlyArray<ImageReference>,
  folders: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<MissingImage> {
  const asked = new Map<string, Set<string>>();
  for (const { file, path } of references)
    asked.set(path, (asked.get(path) ?? new Set()).add(file));
  const missing: MissingImage[] = [];
  for (const [path, files] of asked) {
    const folder = folderOf(path);
    const name = path.slice(folder.length).toLowerCase();
    if ((folders.get(folder) ?? []).some((other) => other.toLowerCase() === name)) continue;
    missing.push({ path, files: [...files].toSorted() });
  }
  return missing.toSorted((a, b) => a.path.localeCompare(b.path));
}

/**
 * Names of the game's pictures, sounds and movies without extension, alone and with the folders
 * below img/, audio/ or movies/, such as `合成物品` and `se/合成物品`, from their paths below the web
 * root. Older plugin headers don't mark which settings are files, but a setting whose value names
 * one of these is a file.
 */
export function assetNames(files: ReadonlyArray<string>) {
  const names = new Set<string>();
  for (const file of files) {
    const [, folder, below] = /^(img|audio|movies)\/(.+?)(?:\.[^./]*)?$/.exec(file) ?? [];
    if (folder === undefined || below === undefined) continue;
    names
      .add(below)
      .add(below.slice(below.lastIndexOf("/") + 1))
      .add(`${folder}/${below}`);
  }
  return names;
}

/**
 * The catalog of a game as inspected now: the entries found, with the translations, choices and
 * settings the saved catalog has for them, if there is one.
 */
/**
 * Each Chinese of `leftover` lines with the line that gives its English, for lines whose id is
 * gone. An entry's id includes its place, so a line that only moved, as when another version adds
 * a command before it, finds its English this way. Chinese the leftovers give different English
 * is left out.
 */
export function englishByText<T extends Pick<Entry, "source" | "translation">>(
  leftover: ReadonlyArray<T>,
) {
  const bySource = new Map<string, T | undefined>();
  for (const line of leftover) {
    const translation = entryTranslation(line);
    if (!translation) continue;
    const seen = bySource.get(line.source);
    if (!bySource.has(line.source)) bySource.set(line.source, line);
    else if (!seen || entryTranslation(seen) !== translation) bySource.set(line.source, undefined);
  }
  return bySource;
}

export function inspectedCatalog(
  game: Pick<Game, "id" | "title" | "engine">,
  entries: ReadonlyArray<Entry>,
  previous: Catalog | undefined,
): Catalog {
  const saved = new Map(previous?.entries.map((entry) => [entry.id, entry]));
  const ids = new Set(entries.map((entry) => entry.id));
  // Image lines come from their read results, which keep their English themselves.
  const moved = englishByText(
    previous?.entries.filter((entry) => !ids.has(entry.id) && !entry.file.startsWith("img/")) ?? [],
  );
  const kept = entries.map((entry) => {
    const old =
      saved.get(entry.id) ?? (entry.file.startsWith("img/") ? undefined : moved.get(entry.source));
    return {
      ...entry,
      ...(old?.readerText !== undefined && { source: old.source, readerText: old.readerText }),
      translation: old?.translation ?? {},
      ...(old?.keepOriginal && { keepOriginal: true }),
      ...(old?.previous && { previous: old.previous }),
    };
  });
  return {
    version: 1,
    game: { id: game.id, title: game.title, engine: game.engine },
    entries: kept,
    glossary: previous?.glossary ?? [],
    translate: previous?.translate ?? false,
    ...(previous?.language && { language: previous.language }),
    ...(previous?.imageBold && { imageBold: previous.imageBold }),
    ...(previous?.imageFont && { imageFont: previous.imageFont }),
    ...(previous?.unchangedImages?.length && { unchangedImages: previous.unchangedImages }),
    ...(previous?.lastRun && { lastRun: previous.lastRun }),
    ...guessRuns({ entries: kept, glossary: previous?.glossary ?? [] }, previous?.runs),
  };
}
