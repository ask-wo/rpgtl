import type { Box, ImageLine, SourceLanguage } from "@rpgtl/contracts";
import * as Schema from "effect/Schema";
import type { ImageRead } from "./imageReading.ts";
import { sourceScript } from "./checks.ts";
import { normalise } from "./imageText.ts";
import { languageNames } from "./language.ts";

/** What Qwen is asked when Paddle read only pieces of an image's lines. */
export const linesPrompt = (language: SourceLanguage) =>
  `Read every piece of text in this image exactly, including ${languageNames[language]} and Latin text. Return one entry per visual line, in reading order, with text and bbox_2d [left, top, right, bottom]. Give bounding boxes in coordinates from 0 to 1000 relative to the full image. Do not translate, explain, or omit repeated button states.`;

const Corner = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }));

/** Qwen's lines, each with a box from 0 to 1000 across the image. */
export const QwenLines = Schema.Struct({
  lines: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      // An array rather than a tuple, which a model's answer format would make an object.
      bbox_2d: Schema.Array(Corner).check(
        Schema.isBetweenLength(4, 4),
        Schema.makeFilter(
          ([left = 0, top = 0, right = 0, bottom = 0]) => left < right && top < bottom,
        ),
      ),
    }),
  ),
});
export type QwenLines = typeof QwenLines.Type;

/** What Qwen is asked about a line in a crop of the image, marked with a red rectangle. */
export const letteringPrompt = (text: string) =>
  `A text reader found the text "${text.trim()}" inside the red rectangle. Is that written lettering, or is it part of a drawing, such as a small figure, an icon, an arrow or a pattern, that only looks like text? Answer lettering or drawing.`;

// An answer held to a format comes without Qwen's thinking, which may name either word.
export const LetteringAnswer = Schema.Struct({ answer: Schema.Literals(["lettering", "drawing"]) });

/** The crop of the image Qwen sees a line in: the line and twice its size around it. */
export const letteringCrop = (box: Box): Box => {
  const size = Math.max(box[2] - box[0], box[3] - box[1]);
  return [box[0] - 2 * size, box[1] - 2 * size, box[2] + 2 * size, box[3] + 2 * size];
};

const outline = (box: Box): ImageLine["polygon"] => [
  [box[0], box[1]],
  [box[2], box[1]],
  [box[2], box[3]],
  [box[0], box[3]],
];

/** Qwen's lines in the image's pixels, with its rough boxes as their outlines. */
export const qwenImageLines = (
  answer: QwenLines,
  size: Pick<ImageRead, "width" | "height">,
): ReadonlyArray<ImageLine> => {
  const x = (value: number) => Math.round((value * size.width) / 1000);
  const y = (value: number) => Math.round((value * size.height) / 1000);
  return answer.lines.map((line) => {
    const [left = 0, top = 0, right = 0, bottom = 0] = line.bbox_2d;
    const box: Box = [x(left), y(top), x(right), y(bottom)];
    return { text: line.text, box, polygon: outline(box), reader: "qwen" };
  });
};

// SequenceMatcher's contiguous matching blocks, including its leftmost tie breaking.
function similarity(left: string, right: string): number {
  const a = normalise(left),
    b = normalise(right);
  function matches(a0: number, a1: number, b0: number, b1: number): number {
    let size = 0,
      ai = a0,
      bi = b0;
    for (let i = a0; i < a1; i++)
      for (let j = b0; j < b1; j++) {
        let length = 0;
        while (i + length < a1 && j + length < b1 && a[i + length] === b[j + length]) length++;
        if (length > size) {
          size = length;
          ai = i;
          bi = j;
        }
      }
    return size ? size + matches(a0, ai, b0, bi) + matches(ai + size, a1, bi + size, b1) : 0;
  }
  return a.length + b.length ? (2 * matches(0, a.length, 0, b.length)) / (a.length + b.length) : 1;
}

const grow = (box: Box, amount: number, width: number, height: number): Box => [
  Math.max(0, Math.floor(box[0] - amount)),
  Math.max(0, Math.floor(box[1] - amount)),
  Math.min(width, Math.ceil(box[2] + amount)),
  Math.min(height, Math.ceil(box[3] + amount)),
];
const area = (box: Box) => (box[2] - box[0]) * (box[3] - box[1]);
function iou(a: Box, b: Box) {
  const intersection =
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return intersection / (area(a) + area(b) - intersection) || 0;
}
const union = (boxes: ReadonlyArray<Box>): Box => [
  Math.min(...boxes.map((box) => box[0])),
  Math.min(...boxes.map((box) => box[1])),
  Math.max(...boxes.map((box) => box[2])),
  Math.max(...boxes.map((box) => box[3])),
];

// A Qwen line replaces a shorter Paddle line it holds, such as 一级 of 下一级, and Paddle's Latin
// misreading of the game's writing, such as OT- for 下一.
const fragment = (p: ImageLine, q: ImageLine) =>
  (normalise(q.text).length > normalise(p.text).length &&
    normalise(q.text).includes(normalise(p.text))) ||
  (sourceScript.test(q.text) && !sourceScript.test(p.text));

/** Paddle's lines and the indices of Qwen's lines that no line of the other reader matches. */
function unmatched(paddle: ImageRead, qwen: ReadonlyArray<ImageLine>) {
  const pairs = paddle.lines.flatMap((p) =>
    qwen.map((q, index) => ({
      p,
      index,
      similarity: similarity(p.text, q.text),
      overlap: iou(p.box, q.box),
      distance:
        Math.abs(p.box[0] + p.box[2] - q.box[0] - q.box[2]) +
        Math.abs(p.box[1] + p.box[3] - q.box[1] - q.box[3]),
      fragment: fragment(p, q),
    })),
  );
  const candidates = [
    ...pairs
      .filter((pair) => pair.similarity >= 0.8 && !pair.fragment)
      .toSorted((a, b) => b.similarity - a.similarity || a.distance - b.distance),
    ...pairs
      .filter((pair) => pair.overlap >= 0.3 && !pair.fragment)
      .toSorted((a, b) => b.overlap - a.overlap),
  ];
  const lines = new Set(paddle.lines);
  const indices = new Set(qwen.keys());
  for (const { p, index } of candidates)
    if (lines.has(p) && indices.has(index)) {
      lines.delete(p);
      indices.delete(index);
    }
  return {
    lines,
    indices: [...indices].filter((index) => sourceScript.test(qwen[index]?.text ?? "")),
  };
}

/**
 * The Chinese, Japanese or Korean lines only Qwen read, by index, each with the crop Paddle reads
 * again at twice its size for an exact outline.
 */
export const qwenCrops = (
  paddle: ImageRead,
  qwen: ReadonlyArray<ImageLine>,
): ReadonlyArray<{ readonly index: number; readonly crop: Box }> =>
  unmatched(paddle, qwen).indices.flatMap((index) => {
    const line = qwen[index];
    if (!line) return [];
    const crop = grow(
      line.box,
      Math.max(line.box[3] - line.box[1], 32),
      paddle.width,
      paddle.height,
    );
    return [{ index, crop }];
  });

/**
 * Paddle's lines with the Chinese, Japanese or Korean lines only Qwen read added, each placed by
 * Paddle's read of its crop (`crops`, by the index `qwenCrops` gave), by Paddle's pieces of it
 * beside it, or roughly.
 */
export function mergeQwenLines(
  paddle: ImageRead,
  qwen: ReadonlyArray<ImageLine>,
  crops: ReadonlyMap<number, ImageRead>,
): ImageRead {
  const { lines: remaining, indices } = unmatched(paddle, qwen);
  let lines = [...paddle.lines];
  for (const index of indices) {
    const q = qwen[index];
    if (!q) continue;
    const crop = crops.get(index)?.lines ?? [];
    const exact = crop.find((line) => similarity(line.text, q.text) >= 0.8);
    // Qwen's box can be off by a few characters, so Paddle's pieces of the line beside it, such as
    // 一级 and OT- of 下一级, give its place when the crop doesn't.
    const height = q.box[3] - q.box[1];
    const beside = (a: Box, b: Box) =>
      Math.min(a[3], b[3]) > Math.max(a[1], b[1]) &&
      Math.max(a[0], b[0]) - Math.min(a[2], b[2]) <= height;
    const fragments = [...remaining].filter((p) => fragment(p, q));
    const parts = fragments.filter((p) => beside(p.box, q.box));
    for (let found = true; found;) {
      const next = fragments.find(
        (p) => !parts.includes(p) && parts.some((part) => beside(part.box, p.box)),
      );
      found = next !== undefined;
      if (next) parts.push(next);
    }
    let placed: ImageLine;
    if (exact) placed = { ...q, ...exact, reader: "qwen" };
    else if (parts.some((p) => sourceScript.test(p.text))) {
      const box = union(parts.map((p) => p.box));
      placed = { ...q, box, polygon: outline(box) };
      for (const p of parts) remaining.delete(p);
      lines = lines.filter((p) => !parts.includes(p));
    } else {
      const whole = normalise(q.text);
      const pieces = crop.filter(
        (line) => normalise(line.text) && whole.includes(normalise(line.text)),
      );
      const covered = new Set<number>();
      for (const piece of pieces) {
        const text = normalise(piece.text);
        for (let start = whole.indexOf(text); start >= 0; start = whole.indexOf(text, start + 1))
          for (let i = start; i < start + text.length; i++) covered.add(i);
      }
      if (pieces.length && covered.size >= 0.8 * whole.length) {
        const box = union(pieces.map((piece) => piece.box));
        placed = { ...q, box, polygon: outline(box) };
      } else {
        const box = grow(q.box, height / 2, paddle.width, paddle.height);
        placed = { ...q, box, polygon: outline(box), rough: true };
      }
    }
    lines = lines.filter((p) => {
      const x = (p.box[0] + p.box[2]) / 2,
        y = (p.box[1] + p.box[3]) / 2;
      return !(
        remaining.has(p) &&
        x >= q.box[0] &&
        x <= q.box[2] &&
        y >= q.box[1] &&
        y <= q.box[3] &&
        normalise(q.text).includes(normalise(p.text))
      );
    });
    lines.push(placed);
  }
  return { width: paddle.width, height: paddle.height, lines };
}
