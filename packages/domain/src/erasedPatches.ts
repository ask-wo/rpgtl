/** An image's pixels, four bytes (RGBA) each, row by row. */
export interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** A rectangle of an erased background that differs from the game's image, and where it goes. */
export interface Patch extends Pixels {
  readonly x: number;
  readonly y: number;
}

/** Patches cover squares of this size, joined along each row of squares. */
const tile = 16;

const crop = (image: Pixels, x: number, y: number, width: number, height: number): Patch => {
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const start = ((y + row) * image.width + x) * 4;
    data.set(image.data.subarray(start, start + width * 4), row * width * 4);
  }
  return { x, y, width, height, data };
};

const differs = (a: Pixels, b: Pixels, x: number, y: number, width: number, height: number) => {
  for (let row = y; row < y + height; row++) {
    const start = (row * a.width + x) * 4;
    for (let index = start; index < start + width * 4; index++)
      if (a.data[index] !== b.data[index]) return true;
  }
  return false;
};

/**
 * The parts of `erased` that differ from `original`, which must be the same size, so the game's
 * image with them drawn over it is `erased` again.
 */
export function erasedPatches(original: Pixels, erased: Pixels): Array<Patch> {
  const patches: Array<Patch> = [];
  for (let y = 0; y < erased.height; y += tile) {
    const height = Math.min(tile, erased.height - y);
    let start: number | undefined;
    for (let x = 0; x < erased.width; x += tile) {
      const changed = differs(original, erased, x, y, Math.min(tile, erased.width - x), height);
      if (changed) start ??= x;
      else if (start !== undefined) {
        patches.push(crop(erased, start, y, x - start, height));
        start = undefined;
      }
    }
    if (start !== undefined) patches.push(crop(erased, start, y, erased.width - start, height));
  }
  return patches;
}

/** `original` with the patches drawn over it; none when a patch reaches outside it. */
export function withPatches(original: Pixels, patches: ReadonlyArray<Patch>): Pixels | undefined {
  const data = original.data.slice();
  for (const patch of patches) {
    if (patch.x + patch.width > original.width || patch.y + patch.height > original.height)
      return undefined;
    for (let row = 0; row < patch.height; row++)
      data.set(
        patch.data.subarray(row * patch.width * 4, (row + 1) * patch.width * 4),
        ((patch.y + row) * original.width + patch.x) * 4,
      );
  }
  return { width: original.width, height: original.height, data };
}
