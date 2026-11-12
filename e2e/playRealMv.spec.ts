// The real-MV game with translations edited on the Text page: they show in the title command a
// plugin adds and in the real message window, which the made-up plugins resize, and a save made
// through the menu loads again from the title screen.
import { expect, test } from "./rpgtl.ts";
import { entryTranslation } from "../packages/domain/src/guesses.ts";
import {
  choose,
  closeMessage,
  confirm,
  idle,
  key,
  loadFromTitle,
  messageWindow,
  newGame,
  saveFromMenu,
  scene,
  sceneIs,
  until,
  walk,
} from "./realMv.ts";

test("translations edited on the Text page show in the game, which saves and loads", async ({
  page,
  openGame,
}) => {
  // On CI this test takes over a minute, close to the default limit.
  test.slow();
  const opened = await openGame("real-MV");
  const english = (source: string) => page.getByRole("textbox", { name: `English for ${source}` });
  await page.locator('label[for="translate-game"]').click();
  await page.locator('a[href$="/text"]').click();
  await english("你醒了。这里是森林。").fill("You wake up. This is the forest.");
  await page
    .getByRole("navigation", { name: "Text files" })
    .getByRole("button", { name: /^Plugins \d/ })
    .click();
  await english("致谢").fill("Thanks");
  await expect(page.getByText("All changes saved")).toBeVisible();
  expect((await opened.saved()).entries.filter(entryTranslation)).toHaveLength(2);

  const game = await opened.play();
  await sceneIs(game, "Scene_Title");
  expect(await game.evaluate("[Graphics.width, Graphics.height].join('x')")).toBe("960x540");
  expect(await game.evaluate(`${scene}._commandWindow._list.map((c) => c.name)`)).toEqual([
    "New Game",
    "Continue",
    "Options",
    "Thanks",
  ]);

  await choose(game, `${scene}._commandWindow`, "credits");
  await sceneIs(game, "Scene_Credits");
  expect(await game.evaluate(`${scene}._creditsWindow._text`)).toBe(
    "感谢你的游玩。\n制作：测试小组",
  );
  await key(game, "Enter");

  await newGame(game);
  await until(game, `${messageWindow}.pause`);
  expect(
    await game.evaluate(
      `({ text: $gameMessage.allText(), rows: ${messageWindow}.numVisibleRows(), height: ${messageWindow}.height, line: ${messageWindow}.lineHeight(), font: ${messageWindow}.contents.fontSize })`,
    ),
  ).toEqual({
    text: "You wake up. This is the forest.",
    rows: 3,
    height: 3 * 30 + 36,
    line: 30,
    font: 22,
  });
  await closeMessage(game);
  await idle(game);

  await walk(game, ["ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowUp", "ArrowUp"]);
  expect(await game.evaluate("[$gamePlayer.x, $gamePlayer.y]")).toEqual([2, 3]);
  await key(game, "ArrowUp");
  await key(game, "Enter");
  // The choices open under the message, so it doesn't pause first; Yes is the default.
  await until(game, `${messageWindow}._choiceWindow.isOpen()`);
  await confirm(game, `${messageWindow}._choiceWindow`);
  for (let i = 0; i < 3; i++) await closeMessage(game);
  await until(game, `${scene}._scrollTextWindow.visible`);
  // Holding OK scrolls three times as fast.
  await key(game, "Enter", 4000);
  await idle(game);
  expect(await game.evaluate("[$gameSwitches.value(1), $gameMap.event(1)._pageIndex]")).toEqual([
    true,
    1,
  ]);

  await saveFromMenu(game);
  expect(await game.evaluate("StorageManager.exists(1)")).toBe(true);
  await walk(game, ["ArrowRight", "ArrowRight"]);
  expect(await game.evaluate("[$gamePlayer.x, $gamePlayer.y]")).toEqual([4, 3]);
  await loadFromTitle(game);
  expect(await game.evaluate("[$gamePlayer.x, $gamePlayer.y, $gameSwitches.value(1)]")).toEqual([
    2,
    3,
    true,
  ]);
});
