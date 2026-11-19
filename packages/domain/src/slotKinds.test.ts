import { assert, it } from "@effect/vitest";
import { slotKind } from "./slotKinds.ts";

it("what fills a code depends on the engine: XP's \\G shows no words, and MV draws a skill's user before its first message only", () => {
  const skill = {
    location: { _tag: "RecordField", table: "skills", record: 1, field: "message1" },
  } as const;
  assert.strictEqual(slotKind("\\G", {}, "XP"), "opens the gold window, no words");
  assert.strictEqual(slotKind("\\G", {}, "MV"), "the currency's name");
  assert.deepStrictEqual(
    [
      slotKind("%1", skill, "MV"),
      slotKind("%1", { location: { ...skill.location, field: "message2" } }, "MV"),
    ],
    [
      "the skill's name; the game draws the user's name right before this message",
      "the skill's name",
    ],
  );
  assert.deepStrictEqual(
    [slotKind("%1", skill, "MZ"), slotKind("%2", skill, "MZ")],
    ["the user's name", "the skill's name"],
  );
});
