// MV's real engine in a browser tab: the game fills the tab, as it fills its window in NW.js, so it
// also fills the screen in full screen.
import { expect, test } from "./rpgtl.ts";
import { expectNoErrors, gameErrors, sceneIs } from "./realMv.ts";

test("the browser-played game fills the tab, and F3 switches that off", async ({ openGame }) => {
  const game = await (await openGame("real-MV")).play();
  const errors = gameErrors(game);
  await sceneIs(game, "Scene_Title");
  await game.setViewportSize({ width: 1632, height: 1248 });
  const width = () =>
    game.evaluate(() => document.querySelector("#GameCanvas")?.getBoundingClientRect().width);

  await expect.poll(width).toBe(1632);
  await game.keyboard.press("F3");
  await expect.poll(width).toBe(await game.evaluate("Graphics.width"));
  await expectNoErrors(game, errors);
});
