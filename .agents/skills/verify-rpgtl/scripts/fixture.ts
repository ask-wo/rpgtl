#!/usr/bin/env node
// Writes a small artificial game for verification. MV and MZ: the test fixture from
// testUtils/fixture.ts on a stubbed engine, plus a common event with Chinese dialogue, so machine
// translation has something to translate. real-MV: the game from testUtils/mvGame.ts on MV's real engine.
// Usage: node fixture.ts <dir> [MV|MZ|real-MV]
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "../../../../packages/game/src/testUtils/fixture.ts";
import { mvGame } from "../../../../packages/game/src/testUtils/mvGame.ts";

const [dir, engine = "MV"] = process.argv.slice(2);
if (!dir || !["MV", "MZ", "real-MV"].includes(engine)) {
  console.error("Usage: node fixture.ts <dir> [MV|MZ|real-MV]");
  process.exit(2);
}
if (engine === "real-MV") {
  console.log(await mvGame(path.resolve(dir)));
  process.exit(0);
}
const webRoot = await fixture(path.resolve(dir), engine as "MV" | "MZ");
const file = path.join(webRoot, "data", "CommonEvents.json");
const events = JSON.parse(await readFile(file, "utf8"));
events.push({
  name: "Chinese dialogue",
  list: [
    { code: 101, parameters: ["", 0, 0, 2, "向导"] },
    { code: 401, parameters: ["你好，旅行者。欢迎来到森林。"] },
    { code: 101, parameters: ["", 0, 0, 2, "向导"] },
    { code: 401, parameters: ["这把剑很重，你要小心。"] },
  ],
});
await writeFile(file, JSON.stringify(events));
console.log(webRoot);
