import { assert, it } from "@effect/vitest";
import { bootEngines } from "./detect.ts";

it("the engine the boot code loads wins over the other engine's core files", () => {
  assert.deepStrictEqual(bootEngines('<script src="js/rpg_core.js"></script>', ""), ["MV"]);
  assert.deepStrictEqual(bootEngines("", 'Utils.RPGMAKER_NAME = "MV"'), ["MV"]);
  assert.deepStrictEqual(bootEngines("", 'loadScript("js/rmmz_core.js")'), ["MZ"]);
  assert.deepStrictEqual(bootEngines('<!-- <script src="js/rpg_core.js"> -->', ""), ["MZ", "MV"]);
});
