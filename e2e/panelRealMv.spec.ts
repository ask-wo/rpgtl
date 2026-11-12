// The F8 panel on MV's real engine, which reads the keys the panel lets through, ends battles
// itself, shows the level-up message and decides whether the player dashes.
import type { Page } from "@playwright/test";
import { expect, test } from "./rpgtl.ts";
import { closeMessage, idle, newGame, scene, sceneIs, until } from "./realMv.ts";

test("the game sees keys let go in the panel and pressed right after it closes", async ({
  openGame,
}) => {
  const game = await (await openGame("real-MV")).play();
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

  // Let go while a control in the panel has the focus.
  await game.keyboard.down("ArrowLeft");
  await until(game, "$gamePlayer.isMoving()");
  await game.keyboard.press("F8");
  await game.locator("#gold").click();
  await game.keyboard.up("ArrowLeft");
  await game.keyboard.press("F8");
  await idle(game);
  expect(await game.evaluate("Input.isPressed('left')")).toBe(false);
});

/** Starts walking with an arrow key and tells whether the player dashes on that step. */
async function dashes(game: Page, arrow: string) {
  await game.keyboard.down(arrow);
  await until(game, "$gamePlayer.isMoving()");
  const dashing = await game.evaluate<boolean>("$gamePlayer.isDashing()");
  await game.keyboard.up(arrow);
  await until(game, "!Input.isPressed('left') && !Input.isPressed('right')");
  await idle(game);
  return dashing;
}

test("the panel wins and loses battles, levels up and dashes", async ({ openGame }) => {
  test.slow();
  const game = await (await openGame("real-MV")).play();
  const dialogs: string[] = [];
  let acceptDialog = false;
  game.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await (acceptDialog ? dialog.accept() : dialog.dismiss());
  });
  const panel = (id: string) => game.locator(`#${id}`);
  async function openPanel() {
    await game.keyboard.press("F8");
    await expect(panel("winBattle")).toBeVisible();
  }
  async function closePanel() {
    await game.keyboard.press("F8");
    await expect(panel("winBattle")).toBeHidden();
  }
  // The engine opens the party's commands once the battle's first message is closed.
  async function startBattle(start: string) {
    await game.evaluate(start);
    await sceneIs(game, "Scene_Battle");
    await closeMessage(game);
    await until(
      game,
      `${scene}._partyCommandWindow.isOpen() && ${scene}._partyCommandWindow.active`,
    );
  }

  await newGame(game);
  await closeMessage(game);
  await idle(game);

  await openPanel();
  await expect(panel("winBattle")).toBeDisabled();
  await expect(panel("loseBattle")).toBeDisabled();
  await expect(panel("level")).toHaveText("Level 1 of 99");
  await panel("levelUp").click();
  await expect(panel("level")).toHaveText("Level 2 of 99");
  expect(await game.evaluate("$gameActors.actor(1).isLearnedSkill(3)")).toBe(true);
  expect(await game.evaluate("$gameMessage.allText()")).toBe(
    "Hero is now Level 2!\nSpark learned!",
  );
  await expect(panel("levelUp"), "a second level-up message would be lost").toBeDisabled();
  await closePanel();
  await closeMessage(game);
  await idle(game);
  await game.evaluate("$gameActors.actor(1).changeLevel(99, false)");
  await openPanel();
  await expect(panel("levelUp")).toBeDisabled();

  await panel("alwaysDash").check();
  expect(await game.evaluate("ConfigManager.alwaysDash")).toBe(true);
  await closePanel();
  expect(await dashes(game, "ArrowRight")).toBe(true);
  // As on a map whose settings turn dashing off.
  await game.evaluate("$dataMap.disableDashing = true");
  expect(await dashes(game, "ArrowLeft")).toBe(false);
  await openPanel();
  await panel("dashOnEveryMap").check();
  await closePanel();
  expect(await dashes(game, "ArrowRight")).toBe(true);

  // Won while the party's commands are open, where the engine doesn't check for the end itself.
  await startBattle("$gameTemp.reserveCommonEvent(3)");
  await openPanel();
  await expect(panel("levelUp")).toBeDisabled();
  await panel("winBattle").click();
  await closePanel();
  await closeMessage(game);
  await sceneIs(game, "Scene_Map");
  await until(game, "$gameVariables.value(3) === 1");

  await startBattle("$gameTemp.reserveCommonEvent(3)");
  await openPanel();
  await panel("loseBattle").click();
  await closePanel();
  await closeMessage(game);
  await sceneIs(game, "Scene_Map");
  await until(game, "$gameVariables.value(3) === 2");
  expect(await game.evaluate("$gameActors.actor(1).isAlive()")).toBe(true);
  expect(dialogs, "a battle that can be lost needs no warning").toEqual([]);

  // As a random encounter, which can't be lost.
  await startBattle(
    "BattleManager.setup(1, true, false); $gamePlayer.makeEncounterCount(); SceneManager.push(Scene_Battle)",
  );
  await openPanel();
  await panel("loseBattle").click();
  expect(dialogs).toHaveLength(1);
  expect(await game.evaluate("$gameParty.aliveMembers().length")).toBe(1);
  acceptDialog = true;
  await panel("loseBattle").click();
  await closePanel();
  await closeMessage(game);
  await sceneIs(game, "Scene_Gameover");
});
