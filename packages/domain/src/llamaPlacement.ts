import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { GgufModel } from "./gguf.ts";

// The process and its host compute buffer: llama-server's anonymous memory reached 1.34 GB during
// 4 parallel requests on Qwen3.6 (4 slots, 4096 context), and its experts took 0.1 GB more than
// their tensors. File cache isn't counted: it can be reclaimed.
const ramAllowance = 1_600_000_000;
// Recurrent state, compute buffers and the CUDA context on Qwen3.6 with 4 slots at 4096 context:
// a placement estimated at all 6.6 GB of free VRAM failed to allocate its last 448 MiB compute
// buffer, after loading for 17 s.
const vramAllowance = 1_460_000_000;
// The vision part's compute buffer: llama-server estimated 1134 MiB of VRAM for Qwen3.6's 861 MiB
// vision file at its largest image.
const projectorAllowance = 273 * 2 ** 20;

/** Bytes of free RAM that llama-server leaves to the rest of the computer. */
export const ramReserve = 2 * 2 ** 30;

/** What a llama-server placement needs, in bytes. */
export interface MemoryEstimate {
  readonly ram: number;
  readonly vram: number;
  /** The layers whose experts the placement keeps in system RAM, of `blockCount`. */
  readonly expertLayersInRam: number;
  readonly blockCount: number;
}

/** Metadata a GGUF model needs for an estimate but lacks. */
export type EstimateProblem = "architecture" | "blockCount" | "attention";

const layerValue = (value: unknown, layer: number) =>
  typeof value === "number"
    ? value
    : Array.isArray(value) && typeof value[layer] === "number"
      ? value[layer]
      : undefined;

const expertTensor = /^blk\.\d+\.ffn_.*_exps(?:\.|$)/;

/**
 * The RAM and VRAM llama-server needs for the model with the experts of its first
 * `expertLayersInRam` layers in system RAM, and `slots` requests of `numCtx` tokens at once.
 */
export const estimateMemory = (
  model: GgufModel,
  options: {
    readonly expertLayersInRam: number;
    readonly numCtx: number;
    readonly slots: number;
    /** The size of the model's vision part, which llama-server keeps in VRAM. */
    readonly projectorBytes?: number;
  },
): Result.Result<MemoryEstimate, EstimateProblem> => {
  const { metadata } = model;
  const architecture = metadata["general.architecture"];
  if (typeof architecture !== "string" || !architecture) return Result.fail("architecture");
  const value = (name: string) => metadata[`${architecture}.${name}`];
  const blockCount = value("block_count");
  if (typeof blockCount !== "number" || !Number.isInteger(blockCount) || blockCount < 0)
    return Result.fail("blockCount");
  // The last layers of a model that predicts more tokens at once, which llama-server doesn't load.
  const predicting = value("nextn_predict_layers");
  const loaded =
    typeof predicting === "number" && Number.isInteger(predicting) && predicting > 0
      ? Math.max(0, blockCount - predicting)
      : blockCount;
  let ram = ramAllowance;
  let vram = vramAllowance;
  for (const tensor of model.tensors) {
    const layer = /^blk\.(\d+)\./.exec(tensor.name)?.[1];
    if (layer !== undefined) {
      const number = Number(layer);
      if (number >= loaded) continue;
      if (expertTensor.test(tensor.name) && number < options.expertLayersInRam) ram += tensor.size;
      else vram += tensor.size;
    } else if (/^token_embd(?:\.|$)/.test(tensor.name)) ram += tensor.size;
    else if (/^output(?:\.|$)/.test(tensor.name)) vram += tensor.size;
  }
  // Only every `interval`th layer of a hybrid model keeps a KV cache.
  const interval = value("full_attention_interval");
  const layers = Array.from({ length: loaded }, (_, layer) => layer).filter(
    (layer) => typeof interval !== "number" || interval <= 0 || (layer + 1) % interval === 0,
  );
  let kvElements = 0;
  for (const layer of layers) {
    const heads = layerValue(value("attention.head_count_kv"), layer);
    const keys = layerValue(value("attention.key_length"), layer);
    const values = layerValue(value("attention.value_length"), layer);
    if (heads === undefined || keys === undefined || values === undefined)
      return Result.fail("attention");
    kvElements += heads * (keys + values);
  }
  // A q8_0 cache stores 32 values in 34 bytes.
  vram += options.numCtx * options.slots * kvElements * (34 / 32);
  if (options.projectorBytes !== undefined) vram += options.projectorBytes + projectorAllowance;
  return Result.succeed({ ram, vram, expertLayersInRam: options.expertLayersInRam, blockCount });
};

/**
 * The estimate with the experts of more layers in system RAM than `expertLayersInRam`, one at a
 * time, until the rest fits in `freeVram` or every layer keeps its experts there. A model without
 * experts keeps its estimate.
 */
export const fittedEstimate = (
  model: GgufModel,
  options: Parameters<typeof estimateMemory>[1] & { readonly freeVram: number },
): Result.Result<MemoryEstimate, EstimateProblem> =>
  Result.flatMap(estimateMemory(model, options), (estimate) =>
    estimate.vram <= options.freeVram ||
    estimate.expertLayersInRam >= estimate.blockCount ||
    !model.tensors.some((tensor) => expertTensor.test(tensor.name))
      ? Result.succeed(estimate)
      : fittedEstimate(model, { ...options, expertLayersInRam: options.expertLayersInRam + 1 }),
  );

/** Which memory a placement needs more of than is free; none when it fits. */
export type Shortage = "ram" | "vram" | "both";

export const shortage = (
  estimate: MemoryEstimate,
  free: { readonly ramLimit: number; readonly vram: number },
): Option.Option<Shortage> => {
  const ram = estimate.ram > free.ramLimit;
  const vram = estimate.vram > free.vram;
  return ram && vram
    ? Option.some("both")
    : ram
      ? Option.some("ram")
      : vram
        ? Option.some("vram")
        : Option.none();
};
