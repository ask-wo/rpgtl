import { assert, it } from "@effect/vitest";
import type { Entry } from "@rpgtl/contracts";
import { isNameEntry, nameGroups } from "./index.ts";

const system = (keys: ReadonlyArray<string>, source: string): Entry => ({
  id: keys.join("."),
  location: { _tag: "SystemText", keys },
  source,
  translation: {},
});

it("the game's title is a name entry, so the glossary pass translates it", () => {
  const title = system(["gameTitle"], "勇者的旅途");
  const currency = system(["currencyUnit"], "金币");
  assert.isTrue(isNameEntry(title));
  assert.isFalse(isNameEntry(currency));
  assert.deepStrictEqual(
    nameGroups([{ ...title }, { ...currency }], 40).map((group) => group.map((entry) => entry.id)),
    [["gameTitle"]],
  );
});

const skill = (record: number, translated: boolean): Entry => ({
  id: `skill ${record}`,
  location: { _tag: "RecordField", table: "skills", record, field: "name" },
  source: `技能${record}`,
  translation: translated ? { user: `Skill ${record}` } : {},
});

it("a long table of names is cut into groups of a batch's untranslated names, so they run side by side", () => {
  const skills = Array.from({ length: 95 }, (_, i) => skill(i + 1, i < 5));
  assert.deepStrictEqual(
    nameGroups(skills, 40).map((group) => group.length),
    [45, 40, 10],
  );
});
