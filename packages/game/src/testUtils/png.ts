import { crc32, deflateSync } from "node:zlib";

function chunk(name: string, bytes: Buffer) {
  const type = Buffer.from(name);
  const out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length);
  type.copy(out, 4);
  bytes.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([type, bytes])), bytes.length + 8);
  return out;
}

/** An RGBA PNG whose pixels `pixel(x, y)` gives as `[r, g, b, a]`. */
export function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly number[] = () => [0, 0, 0, 0],
) {
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) pixels.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
