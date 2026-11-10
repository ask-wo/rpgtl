import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { readGgufHeader } from "./gguf.ts";
import { ggufHeader, testGguf } from "./testUtils/gguf.ts";

describe("readGgufHeader", () => {
  it("reads the metadata and how many bytes each tensor takes", () => {
    const { header, fileSize } = ggufHeader({
      metadata: { "general.architecture": "test", "test.tokens": ["a", "b"], "test.moe": true },
      tensors: [
        { name: "output.weight", size: 64 },
        { name: "blk.0.ffn_up_exps.weight", size: 40 },
      ],
    });
    const model = Result.getOrThrow(readGgufHeader(header, fileSize));
    assert.deepStrictEqual(model.metadata, {
      "general.architecture": "test",
      "test.tokens": ["a", "b"],
      "test.moe": true,
    });
    assert.deepStrictEqual(model.tensors, [
      { name: "output.weight", size: 64 },
      { name: "blk.0.ffn_up_exps.weight", size: 40 },
    ]);
  });

  it("keeps the first 256 items of an array", () => {
    const tokens = Array.from({ length: 300 }, (_, index) => `t${index}`);
    const { header, fileSize } = ggufHeader({ metadata: { tokens }, tensors: [] });
    const model = Result.getOrThrow(readGgufHeader(header, fileSize));
    assert.deepStrictEqual(model.metadata["tokens"], tokens.slice(0, 256));
  });

  it("asks for more of the file when the header goes on past the bytes it got", () => {
    const { header, fileSize } = ggufHeader(testGguf());
    assert.deepStrictEqual(
      readGgufHeader(header.subarray(0, 100), fileSize),
      Result.fail("endsEarly"),
    );
  });

  it("refuses other files and tensors past the end of the file", () => {
    const { header, fileSize } = ggufHeader(testGguf());
    assert.deepStrictEqual(
      readGgufHeader(new TextEncoder().encode("PK\u0003\u0004"), 4),
      Result.fail("notGguf"),
    );
    assert.deepStrictEqual(readGgufHeader(header, fileSize - 3000), Result.fail("invalid"));
  });
});
