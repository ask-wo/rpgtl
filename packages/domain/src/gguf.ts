import * as Result from "effect/Result";

/**
 * Why a GGUF model file's header can't be read. `endsEarly` asks for more of the file: the header
 * holds the model's vocabulary, so how long it is shows only while reading it.
 */
export type GgufProblem = "notGguf" | "endsEarly" | "unsupported" | "invalid";

export interface GgufTensor {
  readonly name: string;
  /** Bytes it takes in the file. */
  readonly size: number;
}

export interface GgufModel {
  /** Metadata values; arrays keep their first 256 items. */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly tensors: ReadonlyArray<GgufTensor>;
}

const maxArrayValues = 256;

const problem = (reason: GgufProblem) => Result.fail(reason);

/** Reads little-endian values from the start of a file, failing once `bytes` runs out. */
class Cursor {
  offset = 0;
  readonly bytes: Uint8Array;
  readonly #view: DataView;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  #take<A>(length: number, read: (at: number) => A): Result.Result<A, GgufProblem> {
    const at = this.offset;
    if (at + length > this.bytes.length) return problem("endsEarly");
    this.offset += length;
    return Result.succeed(read(at));
  }

  u8 = () => this.#take(1, (at) => this.#view.getUint8(at));
  i8 = () => this.#take(1, (at) => this.#view.getInt8(at));
  u16 = () => this.#take(2, (at) => this.#view.getUint16(at, true));
  i16 = () => this.#take(2, (at) => this.#view.getInt16(at, true));
  u32 = () => this.#take(4, (at) => this.#view.getUint32(at, true));
  i32 = () => this.#take(4, (at) => this.#view.getInt32(at, true));
  f32 = () => this.#take(4, (at) => this.#view.getFloat32(at, true));
  f64 = () => this.#take(8, (at) => this.#view.getFloat64(at, true));
  u64 = () =>
    this.#take(8, (at) => Number(this.#view.getBigUint64(at, true))).pipe(Result.flatMap(safe));
  i64 = () =>
    this.#take(8, (at) => Number(this.#view.getBigInt64(at, true))).pipe(Result.flatMap(safe));
  string = () =>
    this.u64().pipe(
      Result.flatMap((length) =>
        this.#take(length, (at) => new TextDecoder().decode(this.bytes.subarray(at, at + length))),
      ),
    );
}

const safe = (value: number): Result.Result<number, GgufProblem> =>
  Number.isSafeInteger(value) ? Result.succeed(value) : problem("invalid");

const readValue = (cursor: Cursor, type: number): Result.Result<unknown, GgufProblem> => {
  switch (type) {
    case 0:
      return cursor.u8();
    case 1:
      return cursor.i8();
    case 2:
      return cursor.u16();
    case 3:
      return cursor.i16();
    case 4:
      return cursor.u32();
    case 5:
      return cursor.i32();
    case 6:
      return cursor.f32();
    case 7:
      return cursor.u8().pipe(Result.map((value) => value !== 0));
    case 8:
      return cursor.string();
    case 9:
      return Result.gen(function* () {
        const itemType = yield* cursor.u32();
        const count = yield* cursor.u64();
        const values: Array<unknown> = [];
        for (let index = 0; index < count; index++) {
          const value = yield* readValue(cursor, itemType);
          if (index < maxArrayValues) values.push(value);
        }
        return values;
      });
    case 10:
      return cursor.u64();
    case 11:
      return cursor.i64();
    case 12:
      return cursor.f64();
    default:
      return problem("unsupported");
  }
};

/**
 * The metadata and tensor sizes in a GGUF file's header, read from `bytes`, the start of a file
 * of `fileSize` bytes.
 */
export const readGgufHeader = (
  bytes: Uint8Array,
  fileSize: number,
): Result.Result<GgufModel, GgufProblem> =>
  Result.gen(function* () {
    const cursor = new Cursor(bytes);
    if (bytes.length < 4) return yield* problem("endsEarly");
    if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "GGUF") return yield* problem("notGguf");
    cursor.offset = 4;
    yield* cursor.u32();
    const tensorCount = yield* cursor.u64();
    const metadataCount = yield* cursor.u64();
    const metadata: Record<string, unknown> = {};
    for (let index = 0; index < metadataCount; index++) {
      const key = yield* cursor.string();
      metadata[key] = yield* readValue(cursor, yield* cursor.u32());
    }
    const offsets: Array<{ readonly name: string; readonly offset: number }> = [];
    for (let index = 0; index < tensorCount; index++) {
      const name = yield* cursor.string();
      const dimensions = yield* cursor.u32();
      for (let dimension = 0; dimension < dimensions; dimension++) yield* cursor.u64();
      yield* cursor.u32();
      offsets.push({ name, offset: yield* cursor.u64() });
    }
    const alignment = metadata["general.alignment"] ?? 32;
    if (typeof alignment !== "number" || !Number.isSafeInteger(alignment) || alignment <= 0)
      return yield* problem("invalid");
    const dataStart = Math.ceil(cursor.offset / alignment) * alignment;
    const sorted = offsets.toSorted((a, b) => a.offset - b.offset);
    const tensors: Array<GgufTensor> = [];
    for (const [index, tensor] of sorted.entries()) {
      const next = sorted[index + 1]?.offset ?? fileSize - dataStart;
      const size = next - tensor.offset;
      if (tensor.offset < 0 || size < 0 || dataStart + tensor.offset + size > fileSize)
        return yield* problem("invalid");
      tensors.push({ name: tensor.name, size });
    }
    return { metadata, tensors };
  });
