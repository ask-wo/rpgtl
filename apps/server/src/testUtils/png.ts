import { PNG } from "pngjs";

/**
 * A real PNG of `width` × `height` grey pixels, with the pixels at `marks` white, and its pixels
 * as the image text code reads them.
 */
export const greyPng = (
  width: number,
  height: number,
  marks: ReadonlyArray<readonly [number, number]> = [],
) => {
  const png = new PNG({ width, height });
  png.data.fill(128);
  for (const [x, y] of marks) png.data.fill(255, (y * width + x) * 4, (y * width + x) * 4 + 4);
  return new Uint8Array(PNG.sync.write(png));
};

/** The RGBA pixels of a PNG. */
export const pixelsOf = (bytes: Uint8Array) =>
  new Uint8Array(PNG.sync.read(Buffer.from(bytes)).data);
