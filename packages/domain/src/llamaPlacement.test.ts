import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { readGgufHeader } from "./gguf.ts";
import { estimateMemory, fittedEstimate, ramReserve, shortage } from "./llamaPlacement.ts";
import { ggufHeader, type TestGguf } from "./testUtils/gguf.ts";

/** 40 layers of 0.5 GB experts, a KV cache every fourth layer, and a 2 GB output layer. */
const model: TestGguf = {
  metadata: {
    "general.architecture": "test",
    "test.block_count": 40,
    "test.full_attention_interval": 4,
    "test.attention.head_count_kv": 8,
    "test.attention.key_length": 128,
    "test.attention.value_length": 128,
  },
  tensors: [
    { name: "token_embd.weight", size: 500_000_000 },
    { name: "output.weight", size: 2_000_000_000 },
    ...Array.from({ length: 40 }, (_, layer) => ({
      name: `blk.${layer}.ffn_down_exps.weight`,
      size: 500_000_000,
    })),
  ],
};
const { header, fileSize } = ggufHeader(model);
const read = Result.getOrThrow(readGgufHeader(header, fileSize));
const estimate = (expertLayersInRam: number) =>
  Result.getOrThrow(estimateMemory(read, { expertLayersInRam, numCtx: 4096, slots: 4 }));

describe("estimateMemory", () => {
  it("puts the experts of the first layers and the embeddings in RAM, the rest and the KV cache in VRAM", () => {
    // 10 layers with a cache of 8 heads × 256 values, for 4 slots of 4096 tokens at q8_0.
    const cache = 10 * 8 * 256 * 4096 * 4 * (34 / 32);
    assert.deepStrictEqual(estimate(31), {
      ram: 1_600_000_000 + 500_000_000 + 31 * 500_000_000,
      vram: 1_460_000_000 + 2_000_000_000 + 9 * 500_000_000 + cache,
      expertLayersInRam: 31,
      blockCount: 40,
    });
  });

  it("leaves out the last layers that only predict further tokens, which llama-server skips", () => {
    const predicting = ggufHeader({
      ...model,
      metadata: { ...model.metadata, "test.nextn_predict_layers": 1 },
    });
    const skipping = Result.getOrThrow(
      estimateMemory(Result.getOrThrow(readGgufHeader(predicting.header, predicting.fileSize)), {
        expertLayersInRam: 31,
        numCtx: 4096,
        slots: 4,
      }),
    );
    // Layer 39 held 0.5 GB of experts and one of the 10 caches.
    const cache = 8 * 256 * 4096 * 4 * (34 / 32);
    assert.strictEqual(skipping.ram, estimate(31).ram);
    assert.strictEqual(skipping.vram, estimate(31).vram - 500_000_000 - cache);
  });

  it("keeps a vision part and its compute buffer in VRAM", () => {
    const vision = estimateMemory(read, {
      expertLayersInRam: 31,
      numCtx: 4096,
      slots: 4,
      projectorBytes: 900_000_000,
    });
    assert.strictEqual(
      Result.getOrThrow(vision).vram - estimate(31).vram,
      900_000_000 + 273 * 2 ** 20,
    );
  });

  it("names the metadata a model lacks", () => {
    const dense = ggufHeader({ ...model, metadata: { "general.architecture": "x" } });
    assert.deepStrictEqual(
      estimateMemory(Result.getOrThrow(readGgufHeader(dense.header, dense.fileSize)), {
        expertLayersInRam: 0,
        numCtx: 4096,
        slots: 4,
      }),
      Result.fail("blockCount"),
    );
  });
});

const free = (ram: number, vram: number) => ({ ramLimit: ram - ramReserve, vram });

const fitted = (freeVram: number) =>
  Result.getOrThrow(
    fittedEstimate(read, { expertLayersInRam: 2, numCtx: 4096, slots: 4, freeVram }),
  );

describe("fittedEstimate", () => {
  it("keeps the experts of more layers in RAM until the rest fits in VRAM", () => {
    const layers = fitted(estimate(30).vram).expertLayersInRam;
    assert.strictEqual(layers, 30);
    assert.strictEqual(fitted(1e12).expertLayersInRam, 2);
  });

  it("stops at every layer when even that doesn't fit, and moves none of a model without experts", () => {
    assert.strictEqual(fitted(0).expertLayersInRam, 40);
    const dense = ggufHeader({
      ...model,
      tensors: model.tensors.map((tensor) => ({
        ...tensor,
        name: tensor.name.replace("_exps", ""),
      })),
    });
    const denseModel = Result.getOrThrow(readGgufHeader(dense.header, dense.fileSize));
    assert.strictEqual(
      Result.getOrThrow(
        fittedEstimate(denseModel, { expertLayersInRam: 0, numCtx: 4096, slots: 4, freeVram: 0 }),
      ).expertLayersInRam,
      0,
    );
  });
});

describe("shortage", () => {
  it("tells which memory a placement needs more of than is free", () => {
    assert.deepStrictEqual(shortage(estimate(31), free(30e9, 5e9)), Option.some("vram"));
    assert.deepStrictEqual(shortage(estimate(40), free(30e9, 5e9)), Option.none());
    assert.deepStrictEqual(shortage(estimate(35), free(12e9, 12e9)), Option.some("ram"));
    assert.deepStrictEqual(shortage(estimate(35), free(12e9, 1e9)), Option.some("both"));
  });
});
