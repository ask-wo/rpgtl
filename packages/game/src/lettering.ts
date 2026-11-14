// Lays out and draws the English into a game image whose text was erased. The runtime and the
// RPGTL page both use it.
import type { DrawBlock } from "@rpgtl/contracts";

/** What lettering uses of a Canvas 2D context, so it draws on a canvas outside a browser too. */
export interface LetteringContext<Image> {
  readonly canvas: { readonly width: number; readonly height: number };
  font: string;
  fillStyle: string | object;
  strokeStyle: string | object;
  lineWidth: number;
  lineJoin: string;
  textAlign: string;
  textBaseline: string;
  globalCompositeOperation: string;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  getTransform(): {
    readonly a: number;
    readonly b: number;
    readonly c: number;
    readonly d: number;
    readonly e: number;
    readonly f: number;
  };
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  drawImage(image: Image, x: number, y: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): {
    readonly width: number;
    readonly actualBoundingBoxAscent: number;
    readonly actualBoundingBoxDescent: number;
  };
}

/** A canvas that lettering can draw on and then draw into another. */
export interface LetteringCanvas<Image> {
  readonly canvas: Image;
  readonly context: LetteringContext<Image>;
}

interface Measured {
  width: number;
  /** How far the text's ink reaches above and below the baseline. */
  ascent: number;
  descent: number;
}
export type Measure = (text: string, font: string) => Measured;
interface PlacedLine {
  text: string;
  /** The left end of the text, and its baseline. */
  x: number;
  y: number;
}
export interface LaidOutBlock {
  block: DrawBlock;
  font: string;
  size: number;
  /** Half the width of the outline: the outline reaches this far beyond the letters. */
  outline: number;
  lines: PlacedLine[];
}

interface Plan {
  size: number;
  lines: string[];
}

const font = (block: DrawBlock, size: number, face: string) =>
  `${block.bold ? "bold " : ""}${size}px ${face}`;
const outlineWidth = (block: DrawBlock, size: number) =>
  block.outline && block.stroke
    ? Math.max(1, Math.round((block.stroke / block.lineHeight) * size))
    : 0;
const gapBetween = (size: number) => Math.max(1, Math.round(0.15 * size));
/**
 * How tall English capitals are at most, as a share of the original line. Many game fonts draw
 * capitals as tall as Chinese characters, and English words are wider, so English as tall as the
 * Chinese looks larger than it.
 */
const capitalScale = 0.75;

/** How close to a side of its space a block is to count as standing at that side. */
const edge = 2;
// A menu's labels differ in length more than the lines of one image, so one at 75% of the median,
// such as Load Game next to Start, still shares the size; a label far too long for its button doesn't.
const seriesShare = 0.7;
const similarHeight = (a: number, b: number) => Math.max(a, b) <= 1.15 * Math.min(a, b);

/** The room a block's English may take around its original. */
const availableTo = (block: DrawBlock) => {
  const [ax0, ay0, ax1, ay1] = block.area as [number, number, number, number];
  const [sx0, sy0, sx1, sy1] = block.space as [number, number, number, number];
  const left = ax0 - sx0,
    right = sx1 - ax1;
  return {
    // A centred block at one edge of its space, such as a short label at a button's left,
    // grows into the room on the other side.
    width: Math.max(
      0,
      block.align === "left"
        ? sx1 - ax0
        : ax1 - ax0 + (Math.min(left, right) <= edge ? left + right : 2 * Math.min(left, right)),
    ),
    height: Math.max(0, ay1 - ay0 + 2 * Math.min(ay0 - sy0, sy1 - ay1)),
  };
};

/** The largest value from 1 to `upper` that fits, assuming whatever fits at a size fits at smaller ones. */
function largest(upper: number, fits: (size: number) => boolean) {
  let low = 1,
    high = upper,
    best: number | undefined;
  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    if (fits(size)) {
      best = size;
      low = size + 1;
    } else high = size - 1;
  }
  return best;
}

function greedyWrap(words: string[], limit: number, widthOf: (text: string) => number) {
  const lines: string[] = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last !== undefined && widthOf(`${last} ${word}`) <= limit)
      lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
  }
  return lines;
}

/**
 * Where each block's English goes and how large it is, in the order of `blocks`. A block first tries
 * one line up to slightly below the original's size, taking the blank space beside it; when that would make it much
 * smaller than the original, it wraps. Blocks that share a size group take the group's smallest size.
 * The character limit the translator gets (`imageLimits` in `@rpgtl/domain`) may be tighter than
 * this room; the room alone decides the size.
 */
export function layoutBlocks(
  given: ReadonlyArray<DrawBlock>,
  face: string,
  measure: Measure,
  /** The blocks of the other images of the image's series (`ImageTextHint.series`). */
  givenSeries: ReadonlyArray<ReadonlyArray<DrawBlock>> = [],
): LaidOutBlock[] {
  // A menu whose labels all start at their images' left edge, whatever their length, as 致谢 does
  // below 环境设置, is left-aligned, which one image alone can't tell.
  const everyBlock = [...given, ...givenSeries.flat()];
  const aligned = (block: DrawBlock): DrawBlock => {
    const alike = everyBlock.filter(
      (other) => other.angle === undefined && similarHeight(other.lineHeight, block.lineHeight),
    );
    return givenSeries.length > 0 &&
      block.angle === undefined &&
      block.align === "centre" &&
      alike.every((other) => Math.abs(other.area[0] - block.area[0]) <= edge) &&
      alike.some((other) => Math.abs(other.area[2] - block.area[2]) > edge)
      ? { ...block, align: "left" }
      : block;
  };
  const blocks = given.map(aligned);
  const series = givenSeries.map((each) => each.map(aligned));
  const cache = new Map<string, Measured>();
  const measured = (text: string, fontText: string) => {
    const key = `${fontText}\0${text}`;
    if (!cache.has(key)) cache.set(key, measure(text, fontText));
    return cache.get(key)!;
  };
  const heightOf = (lines: string[], block: DrawBlock, size: number) => {
    const pad = 2 * outlineWidth(block, size);
    return (
      lines.reduce((sum, text) => {
        const m = measured(text, font(block, size, face));
        return sum + m.ascent + m.descent + pad;
      }, 0) +
      gapBetween(size) * (lines.length - 1)
    );
  };
  const widthOf = (text: string, block: DrawBlock, size: number) =>
    measured(text, font(block, size, face)).width + 2 * outlineWidth(block, size);

  const planFor = (block: DrawBlock): Plan => {
    const available = availableTo(block);
    const target =
      largest(
        Math.max(1, 2 * block.lineHeight),
        (size) =>
          heightOf(["H"], block, size) <= capitalScale * block.lineHeight &&
          heightOf(["Hy"], block, size) <= block.lineHeight,
      ) ?? 1;
    const one = largest(
      target,
      (size) =>
        widthOf(block.text, block, size) <= available.width &&
        heightOf([block.text], block, size) <= block.lineHeight,
    );
    let best: Plan | undefined = one === undefined ? undefined : { size: one, lines: [block.text] };
    const words = block.text.split(/\s+/).filter(Boolean);
    if ((one === undefined || one < 0.75 * target) && words.length > 1) {
      const wrapAt = (size: number, limit: number) =>
        greedyWrap(words, limit, (text) => widthOf(text, block, size));
      const size = largest(target, (candidate) => {
        const lines = wrapAt(candidate, available.width);
        return (
          lines.every((text) => widthOf(text, block, candidate) <= available.width) &&
          heightOf(lines, block, candidate) <= available.height
        );
      });
      if (size !== undefined && (best === undefined || size > best.size)) {
        // Make the lines about equally long without adding a line.
        let lines = wrapAt(size, available.width);
        let low = Math.max(...words.map((word) => widthOf(word, block, size))),
          high = available.width;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (wrapAt(size, middle).length <= lines.length) high = middle;
          else low = middle + 1;
        }
        if (low <= available.width) lines = wrapAt(size, low);
        best = { size, lines };
      }
    }
    return best ?? { size: 1, lines: [block.text] };
  };
  const plans = blocks.map(planFor);

  const groups = new Map<number, number[]>();
  blocks.forEach((block, index) =>
    groups.set(block.group, [...(groups.get(block.group) ?? []), index]),
  );
  for (const members of groups.values()) {
    const sizes = members.map((index) => plans[index]!.size).toSorted((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)]!;
    const sharing = members.filter((index) => plans[index]!.size >= 0.8 * median);
    const smallest = sharing.reduce((a, b) => (plans[b]!.size < plans[a]!.size ? b : a));
    for (const index of sharing) {
      const plan = plans[index]!;
      if (blocks[index]!.text === blocks[smallest]!.text) plan.lines = plans[smallest]!.lines;
      plan.size = plans[smallest]!.size;
    }
  }

  // Buttons of one menu drawn as separate images take one size, as their originals had: each
  // block shares it with the series' blocks of about its original size that aren't far smaller.
  const peers = series.flat().map((block) => ({ block, size: planFor(block).size }));
  if (peers.length > 0)
    blocks.forEach((block, index) => {
      const plan = plans[index]!;
      const sizes = [
        plan.size,
        ...peers
          .filter(({ block: peer }) => similarHeight(peer.lineHeight, block.lineHeight))
          .map(({ size }) => size),
      ].toSorted((a, b) => a - b);
      const median = sizes[Math.floor(sizes.length / 2)]!;
      const shared = Math.min(...sizes.filter((size) => size >= seriesShare * median));
      if (plan.size < seriesShare * median || shared >= plan.size) return;
      plan.size = shared;
      const available = availableTo(block);
      if (
        widthOf(block.text, block, shared) <= available.width &&
        heightOf([block.text], block, shared) <= block.lineHeight
      )
        plan.lines = [block.text];
    });

  return blocks.map((block, index) => {
    const { size, lines } = plans[index]!;
    const fontText = font(block, size, face);
    const outline = outlineWidth(block, size);
    const [ax0, ay0, ax1, ay1] = block.area as [number, number, number, number];
    const [sx0, sy0, sx1, sy1] = block.space as [number, number, number, number];
    const total = heightOf(lines, block, size);
    let top = Math.max(sy0, Math.min(ay0 + (ay1 - ay0 - total) / 2, sy1 - total));
    const placed = lines.map((text): PlacedLine => {
      const m = measured(text, fontText);
      const x =
        block.align === "left"
          ? ax0 + outline
          : Math.max(sx0 + outline, Math.min((ax0 + ax1 - m.width) / 2, sx1 - m.width - outline));
      const line = { text, x, y: top + outline + m.ascent };
      top += m.ascent + m.descent + 2 * outline + gapBetween(size);
      return line;
    });
    return { block, font: fontText, size, outline, lines: placed };
  });
}

/**
 * Replaces the text of `blocks` in the image drawn on `context`, which has the size of `erased`, with
 * pixels from `erased`, and draws the English there. Pixels away from the blocks stay as they are.
 */
export function drawImageText<Image>(
  context: LetteringContext<Image>,
  erased: Image,
  blocks: ReadonlyArray<DrawBlock>,
  face: string,
  series: ReadonlyArray<ReadonlyArray<DrawBlock>>,
  /** A new blank canvas of this size, and its context. */
  newCanvas: (width: number, height: number) => LetteringCanvas<Image>,
) {
  context.save();
  const laid = layoutBlocks(
    blocks,
    face,
    (text, fontText) => {
      context.font = fontText;
      const m = context.measureText(text);
      return {
        width: m.width,
        ascent: m.actualBoundingBoxAscent,
        descent: m.actualBoundingBoxDescent,
      };
    },
    series,
  );
  // The shape the service erased, grown a little by stroking, with the erased pixels inside it.
  // A canvas drawn at a higher resolution than the image (sharp text) scales it through its transform.
  const { canvas: mask, context: shape } = newCanvas(context.canvas.width, context.canvas.height);
  const { a, b, c, d, e, f } = context.getTransform();
  shape.setTransform(a, b, c, d, e, f);
  shape.fillStyle = shape.strokeStyle = "#000";
  shape.lineJoin = "round";
  for (const { polygons, grow } of blocks)
    for (const polygon of polygons) {
      shape.beginPath();
      polygon.forEach(([x, y], index) => (index ? shape.lineTo(x, y) : shape.moveTo(x, y)));
      shape.closePath();
      shape.fill();
      shape.lineWidth = 2 * grow;
      shape.stroke();
    }
  // The mask has the canvas's own pixels, so it goes on without the transform.
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  // Remove the old pixels first, or the original text would show through transparent erased ones.
  context.globalCompositeOperation = "destination-out";
  context.drawImage(mask, 0, 0);
  shape.globalCompositeOperation = "source-in";
  shape.drawImage(erased, 0, 0);
  // Adding keeps the blend straight where the shape's edge is partly transparent.
  context.globalCompositeOperation = "lighter";
  context.drawImage(mask, 0, 0);
  context.restore();
  context.globalCompositeOperation = "source-over";
  context.textBaseline = "alphabetic";
  context.textAlign = "left";
  context.lineJoin = "round";
  for (const { block, font: fontText, outline, lines } of laid) {
    context.save();
    if (block.angle !== undefined) {
      const [x0, y0, x1, y1] = block.area as [number, number, number, number];
      context.translate((x0 + x1) / 2, (y0 + y1) / 2);
      context.rotate((block.angle * Math.PI) / 180);
      context.translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    }
    context.font = fontText;
    for (const { text, x, y } of lines) {
      if (outline) {
        context.strokeStyle = block.outline!;
        context.lineWidth = 2 * outline;
        context.strokeText(text, x, y);
      }
      context.fillStyle = block.fill;
      context.fillText(text, x, y);
    }
    context.restore();
  }
  context.restore();
}
