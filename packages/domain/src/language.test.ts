import { assert, it } from "@effect/vitest";
import { gameLanguage, guessedLanguage } from "./index.ts";

const lines = (...sources: ReadonlyArray<string>) => sources.map((source) => ({ source }));

it("A game's language is guessed from the share of each script, not from a few words", () => {
  assert.strictEqual(guessedLanguage(lines("하루는 시장에 갔다.", "東方 상점")), "korean");
  assert.strictEqual(guessedLanguage(lines("ミナはまだ来ない。", "東の森へ行こう。")), "japanese");
  // A Chinese fan game spelling a Japanese sound in kana.
  assert.strictEqual(
    guessedLanguage(lines("我们出发吧，去东边的森林。", "ナニ？你说什么？")),
    "chinese",
  );
  assert.strictEqual(guessedLanguage(lines("Start", "Options")), "chinese");
});

it("The user's choice of language wins over the guess", () => {
  const entries = lines("하루는 시장에 갔다.");
  assert.strictEqual(gameLanguage({ entries }), "korean");
  assert.strictEqual(gameLanguage({ entries, language: "japanese" }), "japanese");
});
