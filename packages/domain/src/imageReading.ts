import type { Box, GameMap, ImageLine, ImageReadResults, ImageResult } from "@rpgtl/contracts";
import { namedRuns } from "./catalog.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as Result from "effect/Result";
import { sourceScript } from "./checks.ts";
import {
  content,
  imageBlocks,
  inEnglishToo,
  keptLine,
  type KeptLineResult,
  normalise,
  smallImage,
} from "./imageText.ts";

/** What reading an image gives: its size and the lines found in it. */
export type ImageRead = Pick<ImageResult, "width" | "height" | "lines">;

/** The current way of reading, measuring contrast and preparing; older results are redone. */
export const readVersion = 4;
export const contrastVersion = 2;
export const preparedVersion = 13;

/** The SHA-256 of an image file, which tells whether it changed since it was read. */
export const imageHash = (bytes: Uint8Array) => bytesToHex(sha256(bytes));

/** An erased background's file name, from its content, so a changed one never shows from a cache. */
export const erasedName = (bytes: Uint8Array) => `${imageHash(bytes)}.png`;

/** An image of the game that may hold text: its path without extension, and its file. */
export interface GameImage {
  readonly image: string;
  readonly file: string;
}

const textFolders = ["pictures", "titles1", "titles2", "system"];
// The engines' own sheets of emotes, icons, damage numbers, shadows, weapons and window parts,
// whose drawings read as text, and MV's RPG Maker logo. ButtonSet stays: MV's has an OK button,
// which games letter in their own language.
const engineSheets = new Set(
  [
    "Balloon",
    "Damage",
    "IconSet",
    "MadeWithMv",
    "Shadow1",
    "Shadow2",
    "States",
    "Weapons1",
    "Weapons2",
    "Weapons3",
    "Window",
  ].map((name) => `img/system/${name}`),
);
const spriteFolders = new Set([
  "animations",
  "battlebacks1",
  "battlebacks2",
  "characters",
  "enemies",
  "faces",
  "parallaxes",
  "sv_actors",
  "sv_enemies",
  "tilesets",
]);

const folder = (file: string) => file.split("/")[1] ?? "";

// Sorting folder by folder lists a folder's files where the folder sorts among its siblings.
const byFolders = (a: string, b: string) => {
  const left = a.split("/"),
    right = b.split("/");
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const order = (left[index] ?? "").localeCompare(right[index] ?? "");
    if (order) return order;
  }
  return left.length - right.length;
};

/**
 * The images to read for text, from the game's files below `img/` with the game's image
 * extension: the text folders first, then folders of its own, then the parallaxes maps use as
 * their own artwork, whose name starts with "!" as they don't scroll with the map. Tilesets are left
 * out: they come from stock tile packs, whose books, papers and window panes read as text far more
 * often than a sign, and a sign on them is too small to letter in English.
 */
export function textImages(game: {
  readonly extension: string;
  /** Paths below the game's web folder, such as `img/pictures/Notice.png`. */
  readonly files: ReadonlyArray<string>;
  readonly maps: ReadonlyArray<GameMap>;
}): ReadonlyArray<GameImage> {
  // Images directly in img/ belong to no folder the engines load from.
  const images = game.files.filter(
    (file) =>
      /^img\/[^/]+\//.test(file) &&
      file.endsWith(game.extension) &&
      !engineSheets.has(file.slice(0, -game.extension.length)),
  );
  const listed = [
    ...textFolders.flatMap((name) =>
      images.filter((file) => folder(file) === name).toSorted(byFolders),
    ),
    ...images
      .filter((file) => !textFolders.includes(folder(file)) && !spriteFolders.has(folder(file)))
      .toSorted(byFolders),
  ];
  const parallaxes = new Set<string>();
  for (const map of game.maps)
    if (typeof map.parallaxName === "string" && map.parallaxName.startsWith("!"))
      parallaxes.add(`img/parallaxes/${map.parallaxName}`);
  const present = new Set(images);
  const artwork = [...parallaxes]
    .toSorted()
    .map((image) => `${image}${game.extension}`)
    .filter((file) => present.has(file));
  return [...listed, ...artwork].map((file) => ({
    image: file.slice(0, -game.extension.length),
    file,
  }));
}

const xpTextFolders = ["pictures", "titles", "gameovers"];
const xpSpriteFolders = new Set([
  "animations",
  "autotiles",
  "battlebacks",
  "battlers",
  "characters",
  "fogs",
  "icons",
  "panoramas",
  "tilesets",
  "transitions",
  "windowskins",
]);
const xpImage = /^graphics\/[^/]+\/.+\.(png|jpe?g)$/i;

/**
 * The images to read for text in an XP game, from its files below `Graphics/` in the archive and
 * its folder: the text folders first, then folders of its own. Folder names match in any letter
 * case, as `Game.exe` finds files on Windows. Of two files that differ only in letter case or
 * extension, the first is kept, so the archive's should come first, and a PNG wins over a JPEG.
 */
export function xpTextImages(files: ReadonlyArray<string>): ReadonlyArray<GameImage> {
  const found = new Map<string, GameImage>();
  for (const file of files.filter((each) => xpImage.test(each)).toSorted(byPng)) {
    const image = file.slice(0, file.lastIndexOf("."));
    if (!found.has(image.toLowerCase())) found.set(image.toLowerCase(), { image, file });
  }
  const images = [...found.values()];
  const xpFolder = (image: GameImage) => folder(image.image).toLowerCase();
  const sorted = (list: ReadonlyArray<GameImage>) =>
    list.toSorted((a, b) => byFolders(a.image, b.image));
  return [
    ...xpTextFolders.flatMap((name) => sorted(images.filter((image) => xpFolder(image) === name))),
    ...sorted(
      images.filter(
        (image) =>
          !xpTextFolders.includes(xpFolder(image)) && !xpSpriteFolders.has(xpFolder(image)),
      ),
    ),
  ];
}

const byPng = (a: string, b: string) => Number(!/\.png$/i.test(a)) - Number(!/\.png$/i.test(b));

/** Why an image file can't be read as a picture. */
export type ImageFileProblem = "encryptionKey" | "notAnImage";

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

/** The PNG or JPEG of an image file, decrypted with System.json's `encryptionKey` when needed. */
export function decryptImage(
  bytes: Uint8Array,
  key: string | undefined,
): Result.Result<Uint8Array, ImageFileProblem> {
  let image = bytes;
  if (new TextDecoder().decode(bytes.subarray(0, 5)) === "RPGMV") {
    if (!key || !/^[a-f\d]{32}$/i.test(key) || bytes.length < 32)
      return Result.fail("encryptionKey");
    // A copy: a Node Buffer's `slice` is a view, and decrypting would change the file's bytes.
    image = Uint8Array.prototype.slice.call(bytes, 16);
    for (let index = 0; index < 16; index++)
      image[index] = (image[index] ?? 0) ^ Number.parseInt(key.slice(2 * index, 2 * index + 2), 16);
  }
  const png = pngSignature.every((byte, index) => image[index] === byte);
  const jpeg = image[0] === 255 && image[1] === 216 && image[2] === 255;
  return png || jpeg ? Result.succeed(image) : Result.fail("notAnImage");
}

const height = (box: Box) => box[3] - box[1];
const rowOverlap = (a: Box, b: Box) => Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
const gapBetween = (a: Box, b: Box) => Math.max(a[0], b[0]) - Math.min(a[2], b[2]);

const singleCjk = (line: ImageLine) =>
  content(line).length === 1 && sourceScript.test(content(line));

const oneCharacter = (line: ImageLine) =>
  Array.from(content(line)).filter((character) => sourceScript.test(character)).length === 1;

// A short run of Latin letters touching Chinese, Japanese or Korean writing on the same row, such
// as `OT-` before `一级` where the reader took a small 下 for a T.
function latinFragment(line: ImageLine, result: KeptLineResult) {
  if (line.enlarged || (line.score ?? 1) < 0.5 || !/^[A-Za-z]{1,3}$/.test(normalise(line.text)))
    return false;
  const lineHeight = height(line.box);
  return result.lines.some((other) => {
    const otherHeight = height(other.box);
    const smaller = Math.min(lineHeight, otherHeight);
    return (
      keptLine(other, result) &&
      sourceScript.test(content(other)) &&
      Math.max(lineHeight, otherHeight) <= 1.5 * smaller &&
      rowOverlap(line.box, other.box) >= 0.5 * smaller &&
      gapBetween(line.box, other.box) <= 0.25 * Math.max(lineHeight, otherHeight)
    );
  });
}

/**
 * Whether the reader read only pieces of a line: Latin letters touching Chinese, Japanese or
 * Korean writing, or single characters of it close together on one row.
 */
export function partialRead(result: KeptLineResult) {
  if (result.lines.some((line) => latinFragment(line, result))) return true;
  const fragments = result.lines.filter((line) => keptLine(line, result) && singleCjk(line));
  return fragments.some((a, index) =>
    fragments.slice(index + 1).some((b) => {
      const smaller = Math.min(height(a.box), height(b.box));
      return (
        Math.max(height(a.box), height(b.box)) <= 1.5 * smaller &&
        rowOverlap(a.box, b.box) >= 0.5 * smaller &&
        gapBetween(a.box, b.box) <= 2 * Math.max(height(a.box), height(b.box))
      );
    }),
  );
}

/**
 * The lines Qwen checks are lettering. A single character, such as 大 or 方 from a small figure or
 * 人 beside a 7 from a star, is as often artwork as lettering, even with a high score. So is every
 * line of map artwork, where patterns such as windows or fish are read as 国国 or 鱼鱼鱼 far more
 * often than there is a sign.
 */
export const doubtfulLines = (image: string, result: KeptLineResult): ReadonlyArray<ImageLine> =>
  result.lines.filter(
    (line) => keptLine(line, result) && (image.startsWith("img/parallaxes/") || oneCharacter(line)),
  );

/** Whether the fallback reader has something to do in the image. */
export const needsFallback = (image: string, result: KeptLineResult) =>
  !inEnglishToo(result) && (partialRead(result) || doubtfulLines(image, result).length > 0);

/**
 * What a run does with an image, from its saved result: nothing, prepare its saved lines again
 * (`again`), give its saved lines to the fallback reader, or read it.
 */
export type ImagePlan = "keep" | "again" | "fallback" | "read";

export function imagePlan(
  image: string,
  saved: ImageResult | undefined,
  options: {
    readonly sha256: string;
    readonly includeFaint: boolean;
    readonly fallback: boolean;
  },
): ImagePlan {
  if (
    !saved ||
    saved.sha256 !== options.sha256 ||
    saved.error !== undefined ||
    saved.readVersion !== readVersion
  )
    return "read";
  const blocksChanged =
    saved.blocks !== undefined &&
    ((saved.blocks.length > 0 && saved.preparedVersion !== preparedVersion) ||
      // Changed rules for which lines are text leave other blocks to prepare.
      JSON.stringify(saved.blocks.map((block) => block.lines)) !==
        JSON.stringify(imageBlocks(saved)));
  if (
    saved.contrastVersion !== contrastVersion ||
    saved.includeFaint !== options.includeFaint ||
    blocksChanged
  )
    return "again";
  if (options.fallback && saved.fallback === undefined && needsFallback(image, saved))
    return "fallback";
  return saved.blocks === undefined ? "read" : "keep";
}

/** Whether the saved blocks of an image are the ones its lines give now, so they stay prepared. */
export const blocksPrepared = (
  saved: ImageResult | undefined,
  blocks: ReadonlyArray<ReadonlyArray<number>>,
) =>
  saved?.preparedVersion === preparedVersion &&
  saved.blocks !== undefined &&
  JSON.stringify(saved.blocks.map((block) => block.lines)) === JSON.stringify(blocks);

// The reader shrinks an image whose longest side is over 4000 pixels, so reading a larger one at
// twice its size gains nothing.
const largestEnlarged = 2000;

/** How a game image is read after its first read at its own size. */
export type SecondRead =
  /** A small image, such as a menu button, read at four times its size. */
  | "enlarged"
  /** A larger one at twice its size, for small lettering on busy artwork. */
  | "doubled"
  | "none";

export const secondRead = (first: ImageRead): SecondRead =>
  smallImage(first)
    ? "enlarged"
    : Math.max(first.width, first.height) <= largestEnlarged
      ? "doubled"
      : "none";

export const hasText = (read: ImageRead) => read.lines.some((line) => keptLine(line, read));

/**
 * Strips of a small image to read alone when it shows no text: a label under an icon, read with
 * the icon, is often taken for one large Latin letter.
 */
export const imageStrips = ({ width, height: imageHeight }: ImageRead): ReadonlyArray<Box> => [
  [0, Math.floor(0.6 * imageHeight), width, imageHeight],
  [0, 0, width, Math.ceil(0.4 * imageHeight)],
  [0, Math.floor(0.3 * imageHeight), width, Math.ceil(0.7 * imageHeight)],
];

// How much of the smaller box lies inside the other.
const inside = (a: Box, b: Box) =>
  (Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))) /
  Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));

/** The first read with the lines only the read at twice its size found, marked as enlarged. */
export const withDoubledLines = (first: ImageRead, doubled: ImageRead): ImageRead => ({
  ...first,
  lines: [
    ...first.lines,
    ...doubled.lines
      .filter((line) => !first.lines.some((other) => inside(line.box, other.box) > 0.3))
      .map((line) => ({ ...line, enlarged: true as const })),
  ],
});

/** Read results of `images`, with the runs of `runs` that one of them still names. */
export const readResults = (
  images: Record<string, ImageResult>,
  runs: ImageReadResults["runs"],
): ImageReadResults => ({ version: 1, images, ...namedRuns(Object.values(images), runs) });

/** The runs of `results`, each with how many images it read or erased last. */
export const imageRunsWithCounts = ({
  images,
  runs = {},
}: {
  readonly images: Readonly<Record<string, { readonly run?: string }>>;
  readonly runs?: ImageReadResults["runs"];
}) =>
  Object.fromEntries(
    Object.entries(runs).map(([started, run]) => [
      started,
      { ...run, images: Object.values(images).filter((image) => image.run === started).length },
    ]),
  );
