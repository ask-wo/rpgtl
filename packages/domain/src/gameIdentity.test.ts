import { assert, it } from "@effect/vitest";
import type { SavedGame } from "@rpgtl/contracts";
import { folderVersion, otherVersions, sameGameAs } from "./index.ts";

it("a folder's version is the version-like part of its name", () => {
  assert.deepStrictEqual(
    [
      "Moss Garden v0.41",
      "Moss_Garden_1.2.3",
      "Moss Garden Ver1.05",
      "MossGarden[v2]",
      "Moss Garden 2",
      "Moss Garden",
      "Level5",
    ].map(folderVersion),
    ["v0.41", "1.2.3", "Ver1.05", "v2", undefined, undefined, undefined],
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
