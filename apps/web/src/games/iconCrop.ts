/** Alpha at or below which a pixel counts as an empty margin rather than part of the icon. */
const faint = 8;

/** The smallest rectangle holding every visible pixel of RGBA image data, or none when all are clear. */
export function visibleBounds({ data, width, height }: ImageData) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if ((data[(y * width + x) * 4 + 3] ?? 0) > faint) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  if (right < 0) return undefined;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * The icon cut down to its visible pixels as an image address, so icons with transparent margins
 * show as large as ones without; none when it has no margins to cut.
 */
export function croppedIcon(image: HTMLImageElement) {
  const { naturalWidth: width, naturalHeight: height } = image;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.drawImage(image, 0, 0);
  const bounds = visibleBounds(context.getImageData(0, 0, width, height));
  if (!bounds || (bounds.width === width && bounds.height === height)) return undefined;
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  context.drawImage(image, -bounds.x, -bounds.y);
  return canvas.toDataURL();
}
