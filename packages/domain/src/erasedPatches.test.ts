import { assert, it } from "@effect/vitest";
import { erasedPatches, type Pixels, withPatches } from "./index.ts";

/** A `width` × `height` image of one grey, with the pixels at `marks` white. */
const image = (width: number, height: number, marks: ReadonlyArray<[number, number]> = []) => {
  const data = new Uint8Array(width * height * 4).fill(128);
  for (const [x, y] of marks) data.fill(255, (y * width + x) * 4, (y * width + x) * 4 + 4);
  return { width, height, data } satisfies Pixels;
};

it("patches cover only the squares that changed, joined along a row", () => {
  const original = image(40, 40);
  const erased = image(40, 40, [
    [3, 2],
    [20, 5],
    [39, 39],
  ]);
  const patches = erasedPatches(original, erased);
  assert.deepStrictEqual(
    patches.map(({ x, y, width, height }) => [x, y, width, height]),
    [
      [0, 0, 32, 16],
      [32, 32, 8, 8],
    ],
  );
  assert.deepStrictEqual(withPatches(original, patches), erased);
});

it("an erased background like its image needs no patches", () => {
  assert.deepStrictEqual(erasedPatches(image(20, 20), image(20, 20)), []);
});

it("a patch reaching outside the image can't be drawn", () => {
  const patch = { ...image(16, 16), x: 8, y: 0 };
  assert.isUndefined(withPatches(image(20, 20), [patch]));
});
