import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Settings } from "./settings.ts";

const decode = Schema.decodeUnknownEffect(Settings);

describe("Settings", () => {
  it.effect("gives every setting its default when the file has none", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* decode({}), {
        sharpPixels: false,
        sharpText: false,
        ollama: { endpoint: "http://127.0.0.1:11434", runner: "ollama", minExpertLayersInRam: 0 },
        translation: {
          translator: "ollama",
          ollama: {
            model: "qwen3.6:35b-a3b-q4_K_M",
            glossaryModel: "",
            sampling: "temperature-0",
            effort: "off",
          },
          claude: {
            model: "claude-sonnet-5-5",
            glossaryModel: "claude-opus-5-5",
            effort: "medium",
            glossaryEffort: "low",
          },
          codex: {
            model: "",
            glossaryModel: "",
            effort: "medium",
            glossaryEffort: "medium",
          },
        },
        images: { model: "", includeFaint: false },
      });
    }),
  );

  it.effect("keeps what was saved and fills in the rest of its group", () =>
    Effect.gen(function* () {
      const settings = yield* decode({
        translation: { translator: "claude", claude: { model: "claude-haiku-5-5" } },
      });
      assert.strictEqual(settings.translation.translator, "claude");
      assert.deepStrictEqual(settings.translation.claude, {
        model: "claude-haiku-5-5",
        glossaryModel: "claude-opus-5-5",
        effort: "medium",
        glossaryEffort: "low",
      });
    }),
  );

  it.effect(
    "keeps a saved model the CLI may no longer offer, and drops a setting RPGTL no longer has",
    () =>
      Effect.gen(function* () {
        const settings = yield* decode({
          translation: {
            claude: { model: "claude-old", think: true },
            codex: { model: "gpt-old" },
          },
        });
        assert.deepStrictEqual(settings.translation.claude, {
          model: "claude-old",
          glossaryModel: "claude-opus-5-5",
          effort: "medium",
          glossaryEffort: "low",
        });
        assert.strictEqual(settings.translation.codex.model, "gpt-old");
      }),
  );
});
