import { expect, test as it } from "vite-plus/test";
import { croppedIcon, visibleBounds } from "./iconCrop.ts";

/** A 10×10 image, clear but for an opaque block from (2, 3) to (6, 8). */
function padded() {
  const canvas = document.createElement("canvas");
  canvas.width = 10;
  canvas.height = 10;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d canvas");
  context.fillStyle = "red";
  context.fillRect(2, 3, 5, 6);
  return { canvas, context };
}

const loaded = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", reject);
    image.src = src;
  });

it("the visible part of an icon is the rectangle around its non-clear pixels", () => {
  const { context } = padded();
  expect(visibleBounds(context.getImageData(0, 0, 10, 10))).toEqual({
    x: 2,
    y: 3,
    width: 5,
    height: 6,
  });
  expect(visibleBounds(new ImageData(4, 4))).toBeUndefined();
});

it("an icon with clear margins is cut to its visible part, and one without is left alone", async () => {
  const cropped = croppedIcon(await loaded(padded().canvas.toDataURL()));
  expect(cropped).toBeDefined();
  const image = await loaded(cropped ?? "");
  expect([image.naturalWidth, image.naturalHeight]).toEqual([5, 6]);

  const full = document.createElement("canvas");
  full.width = 4;
  full.height = 4;
  full.getContext("2d")?.fillRect(0, 0, 4, 4);
  expect(croppedIcon(await loaded(full.toDataURL()))).toBeUndefined();
});
