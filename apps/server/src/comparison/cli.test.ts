import { defaultChoices } from "@rpgtl/contracts";
import { assert, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { parseSetup } from "./cli.ts";

const endpoint = "http://127.0.0.1:11434";

it("a setup's model picks the translator, and its options set the run's settings", () => {
  assert.deepStrictEqual(
    parseSetup("qwen3@qwen@experts=24@batch=5", endpoint),
    Result.succeed({
      label: "qwen3@qwen@experts=24@batch=5",
      settings: {
        translator: "ollama",
        endpoint,
        ...defaultChoices.ollama,
        model: "qwen3",
        sampling: "qwen",
        expertLayersInRam: 24,
      },
      batchSize: 5,
    }),
  );
  assert.deepStrictEqual(
    parseSetup("qwen3", endpoint),
    Result.succeed({
      label: "qwen3",
      settings: {
        translator: "ollama",
        endpoint,
        ...defaultChoices.ollama,
        model: "qwen3",
        expertLayersInRam: 0,
      },
    }),
  );
  assert.deepStrictEqual(
    parseSetup("qwen3@ollama", endpoint),
    Result.succeed({
      label: "qwen3@ollama",
      settings: { translator: "ollama", endpoint, ...defaultChoices.ollama, model: "qwen3" },
    }),
  );
  assert.deepStrictEqual(
    parseSetup("claude-opus-5-5@effort=low@as=Opus", endpoint),
    Result.succeed({
      label: "Opus",
      settings: {
        translator: "claude",
        model: "claude-opus-5-5",
        glossaryModel: "claude-opus-5-5",
        effort: "low",
        glossaryEffort: "low",
      },
    }),
  );
  assert.deepStrictEqual(
    parseSetup("gpt-6-luna", endpoint),
    Result.succeed({
      label: "gpt-6-luna",
      settings: {
        translator: "codex",
        model: "gpt-6-luna",
        glossaryModel: "",
        effort: "medium",
        glossaryEffort: "medium",
      },
    }),
  );
  assert.deepStrictEqual(
    parseSetup("qwen3@ollama@think", endpoint),
    Result.succeed({
      label: "qwen3@ollama@think",
      settings: {
        translator: "ollama",
        endpoint,
        ...defaultChoices.ollama,
        model: "qwen3",
        effort: "on",
      },
    }),
  );
  assert.deepStrictEqual(
    parseSetup("gpt-oss:20b", endpoint),
    Result.succeed({
      label: "gpt-oss:20b",
      settings: {
        translator: "ollama",
        endpoint,
        ...defaultChoices.ollama,
        model: "gpt-oss:20b",
        expertLayersInRam: 0,
      },
    }),
  );
});

it("an option that doesn't fit the setup's translator, or isn't one, is refused", () => {
  for (const spec of [
    "claude-opus-5-5@qwen",
    "claude-opus-5-5@ollama",
    "qwen3@ollama@experts=4",
    "qwen3@think",
    "qwen3@effort=low",
    "claude-opus-5-5@think",
    "gpt-6-luna@think",
    "qwen3@batch=0",
    "qwen3@experts=x",
    "@qwen",
    "qwen3@fast",
  ])
    assert.isTrue(Result.isFailure(parseSetup(spec, endpoint)), spec);
});
