import { assert, it } from "@effect/vitest";
import {
  kindQuestion,
  pronounQuestion,
  retrySampling,
  samplingOptions,
  shownPronoun,
  translationSystemPrompt,
} from "./index.ts";

it("Retries keep Qwen's settings for Qwen3.6 or when the run uses them, and the model's own otherwise", () => {
  assert.strictEqual(retrySampling("qwen3.6:35b-a3b-q4_K_M", "temperature-0"), "qwen");
  assert.strictEqual(
    retrySampling("hf.co/someone/Qwen3.6-35B-A3B-GGUF:Q4_K_M", "temperature-0"),
    "qwen",
  );
  assert.strictEqual(retrySampling("gemma4:26b", "temperature-0"), "model");
  assert.strictEqual(retrySampling("gemma4:26b", "qwen"), "qwen");
});

it("Temperature 0 stays while the model thinks; Qwen's settings follow whether it thinks", () => {
  assert.deepStrictEqual(samplingOptions("temperature-0", true), { temperature: 0 });
  assert.include(samplingOptions("qwen", false), { temperature: 0.7, top_p: 0.8 });
  assert.include(samplingOptions("qwen", true), { temperature: 1, top_p: 0.95 });
});

it("A Korean game's prompts are written for Korean, with no Chinese examples or rules", () => {
  const han = /\p{Script=Han}/u;
  const prompts = [
    translationSystemPrompt({ language: "korean", names: true, scenes: true, following: true }),
    kindQuestion([{ term: "김민지", usedAs: [], lines: [] }], "korean").system,
    pronounQuestion({ source: "김민지" }, [], "korean").system,
  ];
  for (const prompt of prompts) {
    assert.notMatch(prompt, han);
    assert.notInclude(prompt, "Pinyin");
    assert.notInclude(prompt, "Chinese");
  }
  assert.include(prompts[0], "Revised Romanization");
});

const answer = (evidence: string) => ({ evidence, pronoun: "she" as const });

it("A pronoun is shown by what the character says or a gendered word in the game's language", () => {
  const korean = ["김민지: 오빠, 같이 가자", "김민지는 웃었다 그녀는 기뻤다", "김민지는 웃었다"];
  assert.strictEqual(shownPronoun({ source: "김민지" }, korean, answer("오빠"), "korean"), "she");
  assert.strictEqual(shownPronoun({ source: "김민지" }, korean, answer("그녀는"), "korean"), "she");
  assert.strictEqual(
    shownPronoun({ source: "김민지" }, korean, answer("웃었다"), "korean"),
    "unknown",
  );
  const japanese = ["ミサキ: あたしが行く", "ハヤト: 俺も"];
  assert.strictEqual(
    shownPronoun({ source: "ミサキ" }, japanese, answer("あたし"), "japanese"),
    "she",
  );
  // 他 is other in Japanese, not he.
  const other = ["ハヤトは他の道を行く"];
  assert.strictEqual(
    shownPronoun({ source: "ハヤト" }, other, { evidence: "他", pronoun: "he" }, "japanese"),
    "unknown",
  );
});
