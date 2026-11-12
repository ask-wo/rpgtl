import type {
  Box,
  Catalog,
  DrawBlock,
  Entry,
  ImageLine,
  ImageReadResults,
  ImageResult,
  ImageTextHint,
  Location,
  PreparedBlock,
} from "@rpgtl/contracts";
import { sourceScript } from "./checks.ts";
import { sourceText } from "./engines/mvmz/extract.ts";
import { newEntry } from "./engines/mvmz/location.ts";
import { isImageText } from "./location.ts";
import { entryTranslation, isUserValue, withoutGuess } from "./guesses.ts";

type ImageEntry = Entry & { readonly location: Extract<Location, { readonly _tag: "ImageLines" }> };

function keptPrefix(text: string) {
  const index = text.search(sourceText);
  const prefix = index < 0 ? text : text.slice(0, index);
  return prefix.trim() && prefix.trim().length <= 2 && !/\d/.test(prefix) ? prefix : "";
}

/** The line's text without a short label before it, such as a list's `A.`. */
export const content = (line: ImageLine) => line.text.slice(keptPrefix(line.text).length);

const height = ({ box: [, top, , bottom] }: ImageLine) => bottom - top;
const rowOverlap = (a: ImageLine, b: ImageLine) =>
  Math.min(a.box[3], b.box[3]) - Math.max(a.box[1], b.box[1]);

const minimumContrast = 16;

function faintRow(line: ImageLine, lines: ReadonlyArray<ImageLine>) {
  if (
    line.contrast === undefined ||
    line.contrast > 24 ||
    content(line).length !== 1 ||
    !sourceScript.test(content(line))
  )
    return false;
  const row = lines.filter(
    (other) =>
      (other.score === undefined || other.score >= 0.5) &&
      content(other).length === 1 &&
      sourceScript.test(content(other)) &&
      Math.max(height(line), height(other)) <= 1.5 * Math.min(height(line), height(other)) &&
      rowOverlap(line, other) >= 0.8 * Math.min(height(line), height(other)),
  );
  const faint = row.filter(
    (other) => other.contrast !== undefined && other.contrast < minimumContrast,
  );
  return faint.length >= 2 && faint.length / row.length >= 2 / 3;
}

export type KeptLineResult = Pick<ImageResult, "lines" | "includeFaint"> &
  Partial<Pick<ImageResult, "width" | "height">>;

// Read at twice its size, artwork such as a hair flower is often read as one confident character,
// and a faint watermark as whole lines. Small lettering on busy artwork, which only that read finds,
// is a confident line of a few characters that stands out clearly.
const clearEnlargedLine = (line: ImageLine, result: KeptLineResult) =>
  Array.from(content(line)).filter((character) => sourceScript.test(character)).length >= 3 &&
  line.score !== undefined &&
  line.score >= 0.9 &&
  (result.includeFaint || (line.contrast !== undefined && line.contrast >= 100));

const readableLine = (line: ImageLine, result: KeptLineResult) =>
  (line.score === undefined || line.score >= 0.5) &&
  (!line.enlarged || clearEnlargedLine(line, result)) &&
  (result.includeFaint ||
    line.contrast === undefined ||
    (line.contrast >= minimumContrast && !faintRow(line, result.lines))) &&
  sourceText.test(line.text);

/** Menu icons and buttons, whose lettering is often too small for the reader at its own size. */
export const smallImage = (result: Pick<ImageResult, "width" | "height">) =>
  result.width > 0 && result.height > 0 && Math.max(result.width, result.height) <= 256;

// Artwork such as wood grain or hair is often read as one or two characters with a low score. Real
// lettering alone in a picture scores high, and small images are read enlarged with lower scores.
const artworkGuess = (line: ImageLine, result: KeptLineResult) =>
  line.score !== undefined &&
  line.score < 0.75 &&
  !(
    result.width !== undefined &&
    result.height !== undefined &&
    smallImage({ width: result.width, height: result.height })
  ) &&
  Array.from(content(line).trim()).length <= 2 &&
  !result.lines.some(
    (other) => other !== line && readableLine(other, result) && sourceScript.test(content(other)),
  );

/** Whether the line is text to translate, not artwork or a faint watermark the reader guessed at. */
export const keptLine = (line: ImageLine, result: KeptLineResult) =>
  readableLine(line, result) && !artworkGuess(line, result);

const englishLine = (line: ImageLine) =>
  (line.score === undefined || line.score >= 0.9) &&
  /^[A-Za-z][A-Za-z\s'.,:!?&-]*$/.test(line.text.trim()) &&
  /[A-Za-z]{2}/.test(line.text);

// English lettering directly above or below the line, centred on it as a caption is, and about as
// wide. English read in pieces, such as `New` and `Game`, counts as one line.
function englishBeside(line: ImageLine, lines: ReadonlyArray<ImageLine>) {
  const width = line.box[2] - line.box[0];
  const centre = (line.box[0] + line.box[2]) / 2;
  const side = (gap: (other: ImageLine) => number) => {
    const english = lines.filter((other) => {
      const most = Math.max(height(line), height(other));
      return (
        englishLine(other) &&
        gap(other) >= -0.2 * Math.min(height(line), height(other)) &&
        gap(other) <= most &&
        Math.min(line.box[2], other.box[2]) > Math.max(line.box[0], other.box[0])
      );
    });
    if (english.length === 0) return false;
    const left = Math.min(...english.map((other) => other.box[0]));
    const right = Math.max(...english.map((other) => other.box[2]));
    return (
      right - left >= 0.4 * width &&
      Math.abs((left + right) / 2 - centre) <= 0.2 * Math.max(width, right - left)
    );
  };
  return side((other) => other.box[1] - line.box[3]) || side((other) => line.box[1] - other.box[3]);
}

/**
 * Whether most of the image's lettering already has its English beside it, as a menu button's
 * 开始游戏 over `New Game` does. The image then stays as it is, small lettering in its artwork too.
 */
export function inEnglishToo(result: KeptLineResult) {
  let all = 0;
  let english = 0;
  for (const line of result.lines) {
    if (!keptLine(line, result)) continue;
    const characters = Array.from(content(line)).filter((character) =>
      sourceScript.test(character),
    ).length;
    all += characters;
    if (englishBeside(line, result.lines)) english += characters;
  }
  return english > 0 && english >= all / 2;
}

// Single characters the reader returned separately although they touch: `b` follows `a` in one word.
function sameWord(a: ImageLine, b: ImageLine) {
  const ah = height(a),
    bh = height(b);
  return (
    content(a).length === 1 &&
    content(b).length === 1 &&
    sourceScript.test(content(a)) &&
    sourceScript.test(content(b)) &&
    Math.max(ah, bh) <= 1.5 * Math.min(ah, bh) &&
    rowOverlap(a, b) >= 0.7 * Math.min(ah, bh) &&
    b.box[0] >= a.box[0] &&
    b.box[0] - a.box[2] <= Math.max(ah, bh) / 2
  );
}

// A long line that doesn't end a sentence, continued by the line below it.
const continues = (a: ImageLine, b: ImageLine) => {
  const ah = height(a),
    bh = height(b),
    most = Math.max(ah, bh);
  return (
    a.text.length >= 10 &&
    !/[。！？!?…～~」』）)"]$/.test(a.text) &&
    !keptPrefix(a.text) &&
    !keptPrefix(b.text) &&
    a.text !== b.text &&
    most <= 1.5 * Math.min(ah, bh) &&
    b.box[1] >= a.box[1] &&
    b.box[1] - a.box[3] <= most &&
    (Math.abs(a.box[0] - b.box[0]) <= most / 2 ||
      Math.abs((a.box[0] + a.box[2] - b.box[0] - b.box[2]) / 2) <= most / 2)
  );
};

/** The line indices of each block of text in an image; each block is one entry. */
export function imageBlocks(result: KeptLineResult) {
  if (inEnglishToo(result)) return [];
  const lines = result.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => keptLine(line, result))
    .toSorted((a, b) => a.line.box[1] - b.line.box[1] || a.line.box[0] - b.line.box[0]);
  const blocks: Array<typeof lines> = [];
  for (const item of lines) {
    const block = blocks.at(-1);
    const last = block?.at(-1)?.line;
    if (!block || !last) blocks.push([item]);
    else if (sameWord(last, item.line)) block.push(item);
    // The right character of a word can sit a pixel higher than the left one.
    else if (sameWord(item.line, last)) block.splice(-1, 0, item);
    else if (continues(last, item.line)) block.push(item);
    else blocks.push([item]);
  }
  return blocks.map((block) => block.map((item) => item.index));
}

/** An entry for each block of text the reader found in the images. */
export function imageEntries(results: ImageReadResults) {
  return Object.entries(results.images).flatMap(([file, result]) =>
    imageBlocks(result).map((block) => {
      const lines = block.flatMap((index) => result.lines[index] ?? []);
      const text = lines
        .map((line, i) => {
          const previous = lines[i - 1];
          return (previous && !sameWord(previous, line) ? "\n" : "") + content(line);
        })
        .join("");
      return newEntry({ _tag: "ImageLines", image: file, lines: block }, text);
    }),
  );
}

/** The text the entry's id was made from: for an image's text the user corrected, what was read. */
export const idText = (entry: Pick<Entry, "source" | "readerText">) =>
  entry.readerText ?? entry.source;

/**
 * The image's entry with its text corrected to `text`, or back to what was read when it is that.
 * A run's English was made from the old text, so it is dropped and kept as `previous`, and a
 * rejected answer goes with it; English the user typed stays.
 */
export function withImageText(entry: Entry, text: string): Entry {
  if (text === entry.source) return entry;
  const readerText = idText(entry);
  const { readerText: _, suggestion: __, previous, ...rest } = entry;
  const dropped = isUserValue(entry.translation) ? undefined : entryTranslation(entry) || undefined;
  const kept = dropped ?? previous;
  return {
    ...rest,
    source: text,
    ...(text !== readerText && { readerText }),
    translation: withoutGuess(entry.translation),
    ...(kept !== undefined && { previous: kept }),
  };
}

/** The text without spaces and punctuation, as lines are compared. */
export const normalise = (text: string) => text.replace(/[\s\p{P}]/gu, "");

const sameText = (a: string, b: string) => normalise(a) === normalise(b);

// The box around an entry's lines, from the results it was read from.
function entryBox(results: ImageReadResults | undefined, entry: ImageEntry): Box | undefined {
  const { image, lines: indices } = entry.location;
  const lines = indices.flatMap((index) => results?.images[image]?.lines[index] ?? []);
  if (lines.length === 0) return undefined;
  return [
    Math.min(...lines.map((line) => line.box[0])),
    Math.min(...lines.map((line) => line.box[1])),
    Math.max(...lines.map((line) => line.box[2])),
    Math.max(...lines.map((line) => line.box[3])),
  ];
}

// How much of the smaller box lies inside the other.
function overlap([ax0, ay0, ax1, ay1]: Box, [bx0, by0, bx1, by1]: Box) {
  const shared =
    Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0)) *
    Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
  const smaller = Math.min((ax1 - ax0) * (ay1 - ay0), (bx1 - bx0) * (by1 - by0));
  return smaller > 0 ? shared / smaller : 0;
}

/**
 * The catalog with its image text rebuilt from read results, keeping translations and choices.
 * When an image was read again, an entry's id changes with its lines or text. A new entry then
 * takes the translation and choices of a dropped entry of the same image: one with the same text,
 * or else the one whose lines overlap it most in `before`, the results the catalog's entries were
 * read from, flagged since its text changed. A text the user corrected keeps the correction while
 * the image reads as before.
 */
export function withImageEntries(
  current: Catalog,
  results: ImageReadResults,
  before?: ImageReadResults,
): Catalog {
  const saved = new Map(current.entries.map((entry) => [entry.id, entry]));
  const entries = imageEntries(results);
  const ids = new Set(entries.map((entry) => entry.id));
  const dropped = new Set(
    current.entries
      .filter(isImageText)
      .filter(
        (entry) =>
          !ids.has(entry.id) &&
          (entryTranslation(entry) !== "" || entry.keepOriginal !== undefined),
      ),
  );
  const taken = new Map<ImageEntry, ImageEntry>();
  const take = (entry: ImageEntry, match: (other: ImageEntry) => number) => {
    let best: ImageEntry | undefined;
    let bestScore = 0;
    for (const other of dropped) {
      const score = other.location.image === entry.location.image ? match(other) : 0;
      if (score > bestScore) [best, bestScore] = [other, score];
    }
    if (!best) return;
    dropped.delete(best);
    taken.set(entry, best);
  };
  const unmatched = entries.filter((entry) => !saved.has(entry.id));
  for (const entry of unmatched)
    take(entry, (other) =>
      Number(sameText(idText(other), entry.source) || sameText(other.source, entry.source)),
    );
  for (const entry of unmatched.filter((other) => !taken.has(other))) {
    const box = entryBox(results, entry);
    take(entry, (other) => {
      const old = entryBox(before, other);
      const share = box && old ? overlap(box, old) : 0;
      return share >= 0.5 ? share : 0;
    });
  }
  return {
    ...current,
    entries: [
      ...current.entries.filter((entry) => !isImageText(entry)),
      ...entries.map((entry) => {
        const own = saved.get(entry.id);
        if (own) return { ...entry, ...own };
        const taker = taken.get(entry);
        if (!taker) return entry;
        const { readerText, ...old } = taker;
        const correction = readerText !== undefined && sameText(readerText, entry.source);
        const translation = entryTranslation(old);
        return {
          ...old,
          id: entry.id,
          location: entry.location,
          ...(correction
            ? { source: old.source, readerText: entry.source }
            : { source: entry.source }),
          ...(!correction &&
            !sameText(old.source, entry.source) &&
            translation && {
              translation: {
                guess: {
                  value: translation,
                  flag: `The image was read again; its text was ${old.source}.`,
                },
              },
            }),
        };
      }),
    ],
  };
}

const sameLines = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) =>
  a.length === b.length && a.every((line, index) => line === b[index]);

const middle = (low: number, high: number) => (low + high) / 2;
/**
 * Whether a block is a label in a grid, such as a status screen's stats: another block of about
 * its size sits on its row and another in its column. The game draws values in the blank room
 * beside such labels, so the English gets only the room the original takes.
 */
function inGrid(block: PreparedBlock, blocks: ReadonlyArray<PreparedBlock>) {
  const [ax0, ay0, ax1, ay1] = block.area;
  const alike = blocks.filter(
    (other) =>
      other !== block && Math.abs(other.lineHeight - block.lineHeight) <= 0.25 * block.lineHeight,
  );
  const row = alike.some((other) => {
    const [, oy0, , oy1] = other.area;
    return Math.abs(middle(oy0, oy1) - middle(ay0, ay1)) <= block.lineHeight / 2;
  });
  const column = alike.some((other) => {
    const [ox0, , ox1] = other.area;
    return Math.abs(middle(ox0, ox1) - middle(ax0, ax1)) <= Math.min(ax1 - ax0, ox1 - ox0) / 2;
  });
  return row && column;
}

/**
 * The images of menus drawn as one image per button: a series whose entries are labels of at most
 * 4 characters, of which at least two differ. Name plates repeat one name, and pages of text and
 * item names in a HUD are longer.
 */
function menuImages(entries: ReadonlyArray<ImageEntry>) {
  const bySeries = new Map<string, Array<ImageEntry>>();
  for (const entry of entries) {
    const name = seriesName(entry.location.image);
    if (name !== undefined) bySeries.set(name, [...(bySeries.get(name) ?? []), entry]);
  }
  return new Set(
    [...bySeries.values()]
      .filter(
        (series) =>
          new Set(series.map((entry) => entry.location.image)).size > 1 &&
          new Set(series.map((entry) => entry.source)).size > 1 &&
          series.every((entry) => Array.from(entry.source.trim()).length <= 4),
      )
      .flatMap((series) => series.map((entry) => entry.location.image)),
  );
}

/**
 * How many English characters each image entry has room for, by entry id. Lettering shrinks the
 * font until the English fits, and short labels stay readable down to about half the original size.
 * At that size an average English glyph is about 0.5 em wide, so a line holds the free width divided
 * by 0.25 line heights, and the lines are as many as fit the free height. A menu's button
 * (`menuImages`) of one line counts 0.375 line heights a glyph, for three quarters of the size. The free room is
 * measured as `packages/game/src/lettering.ts` does, except for labels in a grid, which get the original's own
 * width. The limit only steers the translator: the lettering still draws in the whole free room,
 * so a tighter limit never makes text smaller. Entries of blocks that are not prepared are left out.
 */
export function imageLimits(results: ImageReadResults): ReadonlyMap<string, number> {
  const limits = new Map<string, number>();
  const entries = imageEntries(results);
  const menus = menuImages(entries);
  for (const entry of entries) {
    const { image, lines } = entry.location;
    const blocks = results.images[image]?.blocks ?? [];
    const block = blocks.find((item) => sameLines(item.lines, lines));
    if (!block) continue;
    const [ax0, ay0, ax1, ay1] = block.area;
    const [sx0, sy0, sx1, sy1] = block.space;
    const left = ax0 - sx0,
      right = sx1 - ax1;
    const width = inGrid(block, blocks)
      ? ax1 - ax0
      : Math.max(
          0,
          block.align === "left"
            ? sx1 - ax0
            : ax1 - ax0 + (Math.min(left, right) <= 2 ? left + right : 2 * Math.min(left, right)),
        );
    const freeHeight = Math.max(0, ay1 - ay0 + 2 * Math.min(ay0 - sy0, sy1 - ay1));
    const rows = Math.max(1, Math.floor(freeHeight / (1.15 * block.lineHeight)));
    // A menu's button looks shrunk below about three quarters of the original size.
    const glyph = (rows === 1 && menus.has(image) ? 0.375 : 0.25) * block.lineHeight;
    limits.set(entry.id, Math.max(1, Math.floor(width / glyph) * rows));
  }
  return limits;
}

// An icon or bullet the translator copied stays in the image, so it isn't drawn again.
const withoutIcons = (text: string) => text.replace(/^[^A-Za-z0-9"'(“‘]+/, "");

/** The name a series of images shares: the image's path up to a number at its end. */
export const seriesName = (image: string) => /^(.*\D)\d+$/.exec(image)?.[1];

/**
 * The other images of `image`'s series among `images`: the same folder and name up to a number at
 * the end, as a menu's buttons such as `Command_0` and `Command_1`.
 */
export const seriesOf = (image: string, images: Iterable<string>) => {
  const name = seriesName(image);
  return name === undefined
    ? []
    : [...images].filter((other) => other !== image && seriesName(other) === name);
};

/**
 * What the game needs to draw the English into images, by image path such as `img/pictures/Notice`.
 * Only blocks with a translation are included, and images without any are left out, as are images
 * and blocks kept original. `imageBold` overrides whether the original's lettering weight decides,
 * and `imageFont` replaces the game's font. `erasedUrl` makes the address of an erased image from
 * its file name.
 */
export function imageTextHints(
  results: ImageReadResults,
  catalog: Pick<Catalog, "entries" | "imageBold" | "imageFont" | "unchangedImages">,
  erasedUrl: (file: string) => string,
): Record<string, ImageTextHint> {
  const { imageBold: bold, imageFont: font, unchangedImages = [] } = catalog;
  const translated = new Map<string, Array<{ lines: ReadonlyArray<number>; text: string }>>();
  for (const entry of catalog.entries) {
    if (!entryTranslation(entry) || entry.keepOriginal || !isImageText(entry)) continue;
    const { image, lines } = entry.location;
    const blocks = translated.get(image) ?? [];
    blocks.push({ lines, text: entryTranslation(entry) });
    translated.set(image, blocks);
  }
  const hints: Record<string, ImageTextHint> = {};
  for (const [image, result] of Object.entries(results.images)) {
    if (result.error || !result.erased || !result.blocks || unchangedImages.includes(image))
      continue;
    const translations = translated.get(image) ?? [];
    const blocks = result.blocks.flatMap((block): Array<DrawBlock> => {
      const translation = translations.find((candidate) => sameLines(candidate.lines, block.lines));
      const text = withoutIcons((translation?.text ?? "").replace(/\s*\n\s*/g, " ").trim());
      if (!text || block.fill === null) return [];
      const { lines: _lines, weight: _weight, fill, ...drawn } = block;
      return [{ ...drawn, fill, text, bold: bold ? bold === "always" : block.bold }];
    });
    if (blocks.length)
      hints[image] = { erased: erasedUrl(result.erased), blocks, ...(font && { font }) };
  }
  for (const [image, hint] of Object.entries(hints)) {
    const series = seriesOf(image, Object.keys(hints)).flatMap((other) =>
      hints[other] ? [hints[other].blocks] : [],
    );
    if (series.length) hints[image] = { ...hint, series };
  }
  return hints;
}
