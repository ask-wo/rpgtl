import { assert, it } from "@effect/vitest";
import type { Entry } from "@rpgtl/contracts";
import { isNameEntry, nameGroups } from "./index.ts";

const system = (path: ReadonlyArray<string>, source: string): Entry => ({
  id: path.join("."),
  file: "System.json",
  path,
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
