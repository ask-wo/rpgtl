// The map view on MV's real engine, for what the stubbed fixture games can't show: the view staying
// above the canvas the engine creates, a key released while the view is open, teleports the engine
// carries out, a transfer whose map data is still loading, and a loaded save replacing $gameMap.
import type { Page } from "@playwright/test";
import { expect, test } from "./rpgtl.ts";
import {
  closeMessage,
  expectNoErrors,
  gameErrors,
  idle,
  loadFromTitle,
  newGame,
  saveFromMenu,
  scene,
  sceneIs,
  until,
} from "./realMv.ts";

const mapCanvas = 'document.querySelector("#rpgtl-map-view").shadowRoot.querySelector("#map")';
const position = (game: Page) => game.evaluate("[$gameMap.mapId(), $gamePlayer.x, $gamePlayer.y]");
const onMap = (game: Page, mapId: number) =>
  until(
    game,
    `$gameMap.mapId() === ${mapId} && !!$dataMap && ${scene}.constructor === Scene_Map && ${scene}.isActive()`,
  );

test("the map view on MV's real engine", async ({ openGame }) => {
  const game = await (await openGame("real-MV")).play();
  const errors = gameErrors(game);
  const view = game.locator("#rpgtl-map-view");
  const inView = (selector: string) => view.locator(selector);
  const frames = () =>
    game.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  async function openView() {
    await game.keyboard.press("F7");
    await expect(view).toBeVisible();
    await frames();
  }
  async function closeView() {
    await game.keyboard.press("F7");
    await expect(view).toBeHidden();
  }
  // mapGridDraw is where the view last drew the map grid; see the instrumentation below.
  async function clickTile(x: number, y: number, width: number, height: number) {
    const point = await game.evaluate<{ x: number; y: number }>(`(() => {
      const r = ${mapCanvas}.getBoundingClientRect();
      const [left, top, w, h] = mapGridDraw;
      return { x: r.x + left + (${x} + 0.5) * w / ${width}, y: r.y + top + (${y} + 0.5) * h / ${height} };
    })()`);
    await game.mouse.click(point.x, point.y);
    await frames();
  }
  async function pickMap(mapId: number) {
    await inView("#map-picker").selectOption(String(mapId));
    await expect(inView("#title")).toContainText(`Map ${mapId}`);
    await frames();
    await frames();
  }

  await sceneIs(game, "Scene_Title");
  await openView();
  await expect(inView("#empty")).toBeVisible();
  await closeView();

  await newGame(game);
  await closeMessage(game);
  await idle(game);
  await game.evaluate(`(() => {
    const ctx = ${mapCanvas}.getContext("2d");
    const draw = ctx.drawImage.bind(ctx);
    const clear = ctx.clearRect.bind(ctx);
    // The grid is the first image drawn after each clear.
    let gridNext = false;
    ctx.clearRect = (...args) => {
      gridNext = true;
      clear(...args);
    };
    ctx.drawImage = (...args) => {
      if (gridNext) window.mapGridDraw = args.slice(1, 5);
      gridNext = false;
      draw(...args);
    };
  })()`);

  // MV's Graphics set every element's z-index to 0 once the game starts.
  await game.keyboard.down("ArrowRight");
  await until(game, "$gamePlayer.isMoving()");
  await openView();
  expect(await view.evaluate((element) => getComputedStyle(element).zIndex)).toBe("2147483647");
  expect(
    await game.evaluate(
      () =>
        document.elementFromPoint(innerWidth / 2, innerHeight / 2) ===
        document.querySelector("#rpgtl-map-view"),
    ),
  ).toBe(true);
  await game.keyboard.up("ArrowRight");
  const opened = await position(game);
  await game.keyboard.press("ArrowLeft");
  await game.waitForTimeout(300);
  expect(await position(game), "arrow keys don't move the player while the view is open").toEqual(
    opened,
  );
  await game.keyboard.press("F9");
  await expect(
    game.getByText("Nothing to skip"),
    "F9 still reaches the fast forward",
  ).toBeVisible();
  await closeView();
  await idle(game);
  const stopped = await position(game);
  await game.waitForTimeout(500);
  expect(await position(game), "a key released while the view was open doesn't stay held").toEqual(
    stopped,
  );
  expect(await game.evaluate("Input.isPressed('right')")).toBe(false);

  await openView();
  await clickTile(3, 3, 40, 24);
  await expect(inView("#tile-selection")).toContainText("Tile 3, 3 · floor");
  await inView("#teleport-tile").click();
  await until(game, "$gamePlayer.x === 3 && $gamePlayer.y === 3");
  // A wall tile teleports to the nearest floor.
  await clickTile(9, 3, 40, 24);
  await inView("#teleport-tile").click();
  await until(game, "$gamePlayer.x === 8 && $gamePlayer.y === 3");
  await inView('#events button[data-id="1"]').click();
  await inView("#teleport-event").click();
  await until(game, "$gamePlayer.x === 2 && $gamePlayer.y === 3");

  // Event 2 shows one message; while it runs, teleports wait.
  await game.evaluate("$gameMap.event(2).start()");
  await until(game, "$gameMap.isEventRunning()");
  await inView("#teleport-event").click();
  await expect(inView("#map-status")).toContainText("event is running");
  expect(await position(game)).toEqual([1, 2, 3]);
  await closeView();
  await closeMessage(game);
  await idle(game);

  // A transfer to another map: $dataMap is null while its data loads.
  await openView();
  await pickMap(2);
  await clickTile(2, 2, 8, 7);
  await expect(inView("#tile-selection")).toContainText('Map 2 "Second Field" · Tile 2, 2 · floor');
  await game.evaluate(`(() => {
    window.sawNullMap = false;
    const watch = () => {
      if ($dataMap === null) sawNullMap = true;
      else requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  })()`);
  await inView("#teleport-tile").click();
  await onMap(game, 2);
  expect(await game.evaluate("sawNullMap"), "$dataMap was null while map 2 loaded").toBe(true);
  expect(await position(game)).toEqual([2, 2, 2]);
  // The view follows the player there, so it has no map to go back to.
  await expect(inView("#title")).toContainText("Map 2");
  await expect(inView("#back")).toBeHidden();
  await expect(inView("#events button")).toHaveCount(3);
  await closeView();

  await saveFromMenu(game);
  await openView();
  await pickMap(1);
  await clickTile(5, 5, 40, 24);
  await expect(inView("#tile-selection")).toContainText('Map 1 "Forest" · Tile 5, 5 · floor');
  await inView("#teleport-tile").click();
  await onMap(game, 1);
  await inView('#events button[data-id="1"]').click();
  expect(await position(game)).toEqual([1, 5, 5]);
  await closeView();

  await game.evaluate("window.mapBeforeLoad = $gameMap");
  await loadFromTitle(game);
  expect(await position(game)).toEqual([2, 2, 2]);
  expect(await game.evaluate("$gameMap !== mapBeforeLoad"), "loading replaced $gameMap").toBe(true);
  await openView();
  await expect(inView("#title")).toContainText("Map 2");
  await expect(inView("#events button")).toHaveCount(3);
  await expect(inView('#events button[aria-pressed="true"]')).toHaveCount(0);
  await expect(inView("#detail")).toHaveText("");
  await closeView();
  await expectNoErrors(game, errors);
});
