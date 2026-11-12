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
    nameGroups([{ ...title }, { ...currency }]).map((group) => group.map((entry) => entry.id)),
    [["gameTitle"]],
  );
});
