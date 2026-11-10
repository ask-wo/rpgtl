import { assert, it } from "@effect/vitest";
import { hasTerm, nameTerm } from "./index.ts";

it("Korean English that sounds like its Hangul starts as a name, spelled as given", () => {
  assert.deepStrictEqual(nameTerm("김서연", "Kim Seoyeon", false, "korean"), {
    source: "김서연",
    translation: "Kim Seoyeon",
    kind: "name",
  });
  // A Japanese name in Hangul isn't split at a Korean family name (하).
  assert.deepStrictEqual(nameTerm("하루키", "Haruki", false, "korean"), {
    source: "하루키",
    translation: "Haruki",
    kind: "name",
  });
  assert.strictEqual(nameTerm("어둠", "Darkness", false, "korean").kind, "word");
});

it("Pinyin spells only a Chinese game's names", () => {
  assert.strictEqual(nameTerm("林若溪", "Lin Ruoxy", false, "chinese").translation, "Lin Ruoxi");
  assert.deepStrictEqual(nameTerm("林若溪", "Lin Ruoxy", false, "japanese"), {
    source: "林若溪",
    translation: "Lin Ruoxy",
    kind: "word",
  });
});

it("A Hangul term inside a longer word isn't the term, but one with a particle after it is", () => {
  assert.isTrue(hasTerm("토키가 왔다", "토키"));
  assert.isTrue(hasTerm("「토키!」", "토키"));
  assert.isFalse(hasTerm("블랙토키가 왔다", "토키"));
  assert.isTrue(hasTerm("블랙토키가 왔다 토키도", "토키"));
  assert.isTrue(hasTerm("小星澜来了", "星澜"));
});
