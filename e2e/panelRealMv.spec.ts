// The F8 panel on MV's real engine, which reads the keys the panel lets through.
import { test } from "./rpgtl.ts";
import { closeMessage, expectNoErrors, gameErrors, idle, newGame, until } from "./realMv.ts";

test("keys reach the game again once the panel closes", async ({ openGame }) => {
  const game = await (await openGame("real-MV")).play();
  const errors = gameErrors(game);
  await newGame(game);
  await closeMessage(game);
  await idle(game);

  await game.keyboard.press("F8");
  await game.locator("#through").check();
  // Walking right away, in the frame the panel closes.
  await game.keyboard.press("F8");
  await game.keyboard.down("ArrowRight");
  await until(game, "$gamePlayer.isMoving()");
  await game.keyboard.up("ArrowRight");
  await idle(game);

  await expectNoErrors(game, errors);
});
