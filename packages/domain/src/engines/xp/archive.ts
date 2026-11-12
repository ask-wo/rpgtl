import * as Effect from "effect/Effect";
import { GameFileInvalid } from "../mvmz/gameFile.ts";

const magic = new TextEncoder().encode("RGSSAD\0\x01");
const firstKey = 0xdeadcafe;
const nextKey = (key: number) => (Math.imul(key, 7) + 3) >>> 0;

/** Whether the bytes start like an RGSS1 archive (`Game.rgssad`). */
const isArchive = (bytes: Uint8Array) =>
  bytes.length >= magic.length && magic.every((byte, at) => bytes[at] === byte);

/** Each file's bytes XOR the key stream that starts at `key` and moves on every 4 bytes. */
function crypt(bytes: Uint8Array, key: number) {
  const out = new Uint8Array(bytes.length);
  for (let at = 0; at < bytes.length; at += 4, key = nextKey(key))
    for (let byte = 0; byte < 4 && at + byte < bytes.length; byte++)
      out[at + byte] = (bytes[at + byte] ?? 0) ^ ((key >>> (8 * byte)) & 0xff);
  return out;
}

/** A file in an RGSS1 archive: where its bytes are and the key they start with. */
export interface ArchiveEntry {
  /** The path with `/` between folders, as the game asks for it (`Data/Map001.rxdata`). */
  readonly path: string;
  readonly offset: number;
  readonly size: number;
  readonly key: number;
}

const word = (bytes: Uint8Array, at: number) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true);

/**
 * The files of the RGSS1 archive `file` of `size` bytes, read through `read`, which gives the
 * bytes at an offset. Only the headers are read, since an archive holds all of a game's images and
 * sounds too.
 */
export const archiveEntries = Effect.fnUntraced(function* <E>(
  file: string,
  size: number,
  read: (offset: number, length: number) => Effect.Effect<Uint8Array, E>,
) {
  const invalid = (problem: string) => new GameFileInvalid({ file, problem });
  if (size < magic.length || !isArchive(yield* read(0, magic.length)))
    return yield* invalid("it isn't an RPG Maker XP archive");
  const entries: ArchiveEntry[] = [];
  let key = firstKey;
  let at = magic.length;
  while (at < size) {
    if (at + 4 > size) return yield* invalid("it ends in the middle of a file");
    const nameLength = (word(yield* read(at, 4), 0) ^ key) >>> 0;
    key = nextKey(key);
    at += 4;
    if (at + nameLength + 4 > size) return yield* invalid("it ends in the middle of a file");
    const header = yield* read(at, nameLength + 4);
    const name = header.slice(0, nameLength).map((byte) => {
      const plain = byte ^ (key & 0xff);
      key = nextKey(key);
      return plain;
    });
    const length = (word(header, nameLength) ^ key) >>> 0;
    key = nextKey(key);
    at += nameLength + 4;
    if (at + length > size) return yield* invalid("it ends in the middle of a file");
    const path = new TextDecoder().decode(name).replaceAll("\\", "/");
    entries.push({ path, offset: at, size: length, key });
    at += length;
  }
  return entries;
});

/** The content of an archive's file from its bytes as stored. */
export const decryptEntry = (entry: ArchiveEntry, bytes: Uint8Array) => crypt(bytes, entry.key);

/** An RGSS1 archive of the files, with `\` between folders as the editor writes them. */
export function writeArchive(files: ReadonlyMap<string, Uint8Array>) {
  const parts: Uint8Array[] = [magic];
  let key = firstKey;
  const writeWord = (value: number) => {
    const part = new Uint8Array(4);
    new DataView(part.buffer).setUint32(0, (value ^ key) >>> 0, true);
    key = nextKey(key);
    parts.push(part);
  };
  for (const [path, data] of files) {
    const name = new TextEncoder().encode(path.replaceAll("/", "\\"));
    writeWord(name.length);
    parts.push(
      name.map((byte) => {
        const secret = byte ^ (key & 0xff);
        key = nextKey(key);
        return secret;
      }),
    );
    writeWord(data.length);
    parts.push(crypt(data, key));
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  parts.reduce((at, part) => (out.set(part, at), at + part.length), 0);
  return out;
}
