import { DatabaseSync } from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { GameSettings } from "@rpgtl/contracts";

const database = new URL("formats/3/state/games/4d6f73734c616e746572/game.db", import.meta.url)
  .pathname;

it("format 3's database saves every game setting", () => {
  const db = new DatabaseSync(database, { readOnly: true });
  const names = db.prepare("select name from settings").all();
  db.close();
  assert.sameMembers(
    names.map(({ name }) => String(name)),
    Object.keys(GameSettings.fields),
  );
});
