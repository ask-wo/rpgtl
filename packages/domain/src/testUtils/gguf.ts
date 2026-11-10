type Value = string | number | boolean | ReadonlyArray<string | number | boolean>;

export interface TestGguf {
  readonly metadata: Readonly<Record<string, Value>>;
  readonly tensors: ReadonlyArray<{ readonly name: string; readonly size: number }>;
}

/** A model with 40 layers of experts, a KV cache every fourth layer and tiny tensors. */
export const testGguf = (blockCount = 40): TestGguf => ({
  metadata: {
    "general.architecture": "test",
    "general.alignment": 32,
    "test.block_count": blockCount,
    "test.full_attention_interval": 4,
    "test.attention.head_count_kv": 2,
    "test.attention.key_length": 8,
    "test.attention.value_length": 8,
  },
  tensors: [
    { name: "token_embd.weight", size: 1_000_000 },
    { name: "output.weight", size: 1_000_000 },
    ...Array.from({ length: blockCount }, (_, layer) => [
      { name: `blk.${layer}.attn_norm.weight`, size: 2_000 },
      { name: `blk.${layer}.ffn_down_exps.weight`, size: 2_000 },
      { name: `blk.${layer}.ffn_gate_exps.weight`, size: 2_000 },
      { name: `blk.${layer}.ffn_up_exps.weight`, size: 2_000 },
    ]).flat(),
  ],
});

const typeOf = (value: Value): number =>
  typeof value === "string" ? 8 : typeof value === "boolean" ? 7 : Array.isArray(value) ? 9 : 4;

/**
 * The header of a GGUF file holding `model`, and the size of the whole file: the tensors' data
 * after the header is left out, so a test writes it as a sparse file.
 */
export const ggufHeader = (model: TestGguf) => {
  const parts: Array<Uint8Array> = [];
  const fixed = (size: number, write: (view: DataView) => void) => {
    const bytes = new Uint8Array(size);
    write(new DataView(bytes.buffer));
    parts.push(bytes);
  };
  const u32 = (value: number) => fixed(4, (view) => view.setUint32(0, value, true));
  const u64 = (value: number) => fixed(8, (view) => view.setBigUint64(0, BigInt(value), true));
  const string = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    u64(bytes.length);
    parts.push(bytes);
  };
  const value = (item: Value) => {
    if (typeof item === "string") string(item);
    else if (typeof item === "boolean") fixed(1, (view) => view.setUint8(0, item ? 1 : 0));
    else if (typeof item === "number") u32(item);
    else {
      u32(typeOf(item[0] ?? 0));
      u64(item.length);
      for (const entry of item) value(entry);
    }
  };
  parts.push(new TextEncoder().encode("GGUF"));
  u32(3);
  u64(model.tensors.length);
  u64(Object.keys(model.metadata).length);
  for (const [key, item] of Object.entries(model.metadata)) {
    string(key);
    u32(typeOf(item));
    value(item);
  }
  let offset = 0;
  for (const tensor of model.tensors) {
    offset = Math.ceil(offset / 32) * 32;
    string(tensor.name);
    u32(1);
    u64(1);
    u32(0);
    u64(offset);
    offset += tensor.size;
  }
  const header = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    header.set(part, at);
    at += part.length;
  }
  return { header, fileSize: Math.ceil(header.length / 32) * 32 + offset };
};
