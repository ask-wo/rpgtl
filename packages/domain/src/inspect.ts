import type { Catalog, Entry, MissingFile, Text } from "@rpgtl/contracts";
import * as Predicate from "effect/Predicate";
import { type ReadEntry, textsById } from "./catalog.ts";
import { showTextSpeakers } from "./reuse.ts";
import { canKeepOriginal, isImageText } from "./location.ts";

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

/** A file a data file asks for, without extension, such as `img/faces/Actor1` or `audio/se/Door`. */
export interface MediaReference {
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
// Fields and event command parameters that hold a sound as `{ name, volume, pitch, pan }`, or a
// list of them, and the folder it is in.
const audioFields: Record<string, string> = {
  bgm: "audio/bgm/",
  bgs: "audio/bgs/",
  se: "audio/se/",
  sounds: "audio/se/",
  titleBgm: "audio/bgm/",
  battleBgm: "audio/bgm/",
  victoryMe: "audio/me/",
  defeatMe: "audio/me/",
  gameoverMe: "audio/me/",
};
const audioParameters: Record<number, Record<number, string>> = {
  132: { 0: "audio/bgm/" }, // Change Battle BGM
  133: { 0: "audio/me/" }, // Change Victory ME
  139: { 0: "audio/me/" }, // Change Defeat ME
  140: { 1: "audio/bgm/" }, // Change Vehicle BGM
  241: { 0: "audio/bgm/" }, // Play BGM
  245: { 0: "audio/bgs/" }, // Play BGS
  249: { 0: "audio/me/" }, // Play ME
  250: { 0: "audio/se/" }, // Play SE
  44: { 0: "audio/se/" }, // Play SE in a move route
};
// A map keeps the music it doesn't play too.
const autoplay: Record<string, string> = { bgm: "autoplayBgm", bgs: "autoplayBgs" };

const soundName = (sound: unknown) =>
  Predicate.hasProperty(sound, "name") && Predicate.isString(sound.name) ? sound.name : "";

/** The images and sounds the data of `file` asks for. */
export function mediaReferences(file: string, data: unknown): ReadonlyArray<MediaReference> {
  const references: MediaReference[] = [];
  const add = (folder: string, name: string) => {
    if (name) references.push({ file, path: folder + name });
  };
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
        if (Predicate.isString(name)) add(folder, name);
      }
      for (const [index, folder] of Object.entries(audioParameters[node.code] ?? {}))
        add(folder, soundName(parameters[Number(index)]));
    }
    const fields = new Map(Object.entries(node));
    for (const [key, value] of fields) {
      const imageFolder = imageFields[key];
      const audioFolder = audioFields[key];
      if (Predicate.isString(value) && imageFolder) add(imageFolder, value);
      else if (audioFolder && Predicate.isObjectOrArray(value)) {
        const flag = autoplay[key];
        if (flag && fields.get(flag) === false) continue;
        for (const sound of Array.isArray(value) ? value : [value])
          add(audioFolder, soundName(sound));
      } else walk(value);
    }
  };
  walk(data);
  return references;
}

const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

/** The folders, such as `img/faces/`, that the references are in. */
export const referencedFolders = (references: ReadonlyArray<MediaReference>) => [
  ...new Set(references.map(({ path }) => folderOf(path))),
];

const imageExtension = /\.(?:png|rpgmvp|png_)$/i;

/**
 * The names without extension of the files in `folder`. Any file counts as a sound: plugins play
 * other formats than the engine, and `mediaWarnings` names the ones NW.js can't play.
 */
export const mediaNames = (folder: string, files: ReadonlyArray<string>) =>
  [
    ...new Set(
      folder.startsWith("img/")
        ? files
            .filter((file) => imageExtension.test(file))
            .map((file) => file.replace(imageExtension, ""))
        : files.map((file) => file.replace(/\.[^.]*$/, "")),
    ),
  ].toSorted();

/**
 * The files the references ask for that no name in `folders` (names by folder) is. A file whose
 * name differs only in case is found by both play modes, so it isn't missing.
 */
export function missingFiles(
  references: ReadonlyArray<MediaReference>,
  folders: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<MissingFile> {
  const asked = new Map<string, Set<string>>();
  for (const { file, path } of references)
    asked.set(path, (asked.get(path) ?? new Set()).add(file));
  const missing: MissingFile[] = [];
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

/** An entry as reading the game gives it, with what makes up its text's key. */
export type InspectedEntry = ReadEntry &
  Pick<Text, "isInImage"> &
  Partial<Pick<Entry, "isLeftUntranslated">>;

/**
 * The entries of a game as read now, each with its text's key, the speaker included, and the user's choices that
 * `previous`, the saved catalog, has for it. An image text the user corrected keeps the
 * correction while it reads the same. Translations belong to texts, so a line that only moved, as
 * when another version adds a command before it, keeps its English by its text.
 */
export function inspectedEntries(
  read: ReadonlyArray<ReadEntry>,
  previous: Pick<Catalog, "entries" | "texts"> | undefined,
): InspectedEntry[] {
  const saved = new Map(previous?.entries.map((entry) => [entry.id, entry]));
  const texts = previous ? textsById(previous) : new Map<number, Text>();
  const speakerOf = showTextSpeakers(read);
  return read.map((entry) => {
    const old = saved.get(entry.id);
    const image = isImageText(entry);
    const corrected = image && old ? texts.get(old.textId)?.source : undefined;
    const { speaker: _, ...rest } = entry;
    const speaker = image ? undefined : speakerOf(entry);
    return {
      ...rest,
      ...(speaker !== undefined && { speaker }),
      ...(corrected !== undefined && { source: corrected }),
      isInImage: image,
      ...(old?.isLeftUntranslated && canKeepOriginal(entry) && { isLeftUntranslated: true }),
    };
  });
}
