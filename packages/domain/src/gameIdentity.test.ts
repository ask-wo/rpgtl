import { assert, it } from "@effect/vitest";
import type { SavedGame } from "@rpgtl/contracts";
import { otherVersions, sameGameAs, splitVersion } from "./index.ts";

it("a name's version is its version-like part written as v and its number, and the rest without it is its name", () => {
  assert.deepStrictEqual(
    [
      "Moss Garden V.0.41B",
      "Moss_Garden_1.2.3",
      "Moss Garden Ver 1.05 Demo",
      "MossGarden[v2]",
      "苔の庭（v1.1）",
      "Moss Garden 2",
      "Level5",
      "v1.0",
      "Moss Garden Patreon 0-1-1",
      "Moss Garden 2022-08-06",
      "Moss Garden 2022.08.06",
    ].map(splitVersion),
    [
      { name: "Moss Garden", version: "v0.41b" },
      { name: "Moss_Garden", version: "v1.2.3" },
      { name: "Moss Garden Demo", version: "v1.05" },
      { name: "MossGarden", version: "v2" },
      { name: "苔の庭", version: "v1.1" },
      { name: "Moss Garden 2" },
      { name: "Level5" },
      { name: "v1.0", version: "v1.0" },
      { name: "Moss Garden Patreon", version: "v0.1.1" },
      { name: "Moss Garden 2022-08-06" },
      { name: "Moss Garden 2022.08.06" },
    ],
  );
});

const mz = { engine: "MZ" as const, title: "Rain" };

it("MZ's game id says two games are the same, an encryption key with the title is sure, and a title alone only maybe", () => {
  assert.strictEqual(
    sameGameAs(
      { ...mz, identity: { gameId: 1 } },
      { ...mz, title: "Rain 2", identity: { gameId: 1 } },
    ),
    "sure",
  );
  assert.isUndefined(
    sameGameAs({ ...mz, identity: { gameId: 1 } }, { ...mz, identity: { gameId: 2 } }),
  );
  const keyed = { ...mz, engine: "MV" as const, identity: { encryptionKey: "0f" } };
  assert.strictEqual(sameGameAs(keyed, keyed), "sure");
  assert.strictEqual(sameGameAs(keyed, { ...keyed, identity: { encryptionKey: "1e" } }), "maybe");
  assert.strictEqual(sameGameAs(mz, { ...mz, identity: { gameId: 1 } }), "maybe");
  assert.isUndefined(sameGameAs(mz, { ...mz, title: "Snow" }));
  assert.isUndefined(sameGameAs(mz, { ...mz, engine: "MV" }));
});

it("titles that differ only in the number they end with are maybe the same game", () => {
  const xp = { engine: "XP" as const, identity: {} };
  const maybe = (a: string, b: string) => sameGameAs({ ...xp, title: a }, { ...xp, title: b });
  assert.strictEqual(maybe("Rain_TEST12", "Rain_TEST40"), "maybe");
  assert.strictEqual(maybe("Rain 2", "Rain 3"), "maybe");
  assert.isUndefined(maybe("Rain_TEST12", "Snow_TEST12"));
  assert.isUndefined(maybe("Rain", "Rain 2"));
  assert.isUndefined(maybe("12", "13"));
});

it("other versions are saved games in other folders, the surest and then the latest saved first", () => {
  const saved = (id: string, webRoot: string, gameId?: number): SavedGame => ({
    ...mz,
    id,
    root: webRoot,
    webRoot,
    files: [],
    encryptedAssets: false,
    mediaWarnings: [],
    missingImages: [],
    ...(gameId !== undefined && { identity: { gameId } }),
  });
  const found = { ...mz, webRoot: "/new", identity: { gameId: 1 } };
  assert.deepStrictEqual(
    otherVersions(found, [
      saved("a", "/a"),
      saved("b", "/b", 1),
      saved("c", "/c"),
      saved("d", "/d", 2),
      saved("e", "/new", 1),
    ]).map(({ game, sure }) => [game.id, sure]),
    [
      ["b", true],
      ["c", false],
      ["a", false],
    ],
  );
});
