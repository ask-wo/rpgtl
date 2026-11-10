// Plays MV's real engine the way a player does. The engine reads keys once per frame, so each key
// is held for a few frames. verify-rpgtl's examples/real-mv.ts has the same helpers for its own
// driver: a fix to one belongs in the other too.
import { expect, type Page } from "@playwright/test";

export const scene = "SceneManager._scene";
export const messageWindow = `${scene}._messageWindow`;

/** Waits until a script expression in the game is true. */
export const until = (game: Page, expression: string, timeout = 10_000) =>
  game.waitForFunction(expression, undefined, { timeout, polling: 50 });

/** Waits until the scene is `name` (a class such as "Scene_Map") and has finished starting. */
export const sceneIs = (game: Page, name: string) =>
  until(game, `${scene}?.constructor === ${name} && ${scene}.isActive()`, 20_000);

/** The key codes of the keys the tests press, which MV's `Input.keyMapper` turns into buttons. */
const keyCodes: Record<string, number> = {
  Enter: 13,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};

/**
 * A script that makes the game's next input read after the key's keydown see it held, and the
 * read after that see it let go, then sets `rpgtlKeyRead`. MV reads input once per update, so a
 * key let go before the next update is never read; and it runs several updates in one frame when
 * it falls behind, so a slow test can hold a key past the 24 updates after which MV repeats it.
 * The key still goes down through the browser, so a key RPGTL keeps from the game is never read.
 */
const readOnce = (name: string) => {
  const code = keyCodes[name];
  if (code === undefined) throw new Error(`No key code for ${name}`);
  return `(() => {
    const button = Input.keyMapper[${code}];
    const update = Input.update;
    let pressed = false;
    const latch = (event) => { if (event.keyCode === ${code}) pressed = true; };
    document.addEventListener("keydown", latch);
    window.rpgtlKeyRead = false;
    Input.update = function () {
      if (pressed) this._currentState[button] = true;
      update.call(this);
      if (!pressed) return;
      document.removeEventListener("keydown", latch);
      Input.update = update;
      this._currentState[button] = false;
      window.rpgtlKeyRead = true;
    };
  })()`;
};

/**
 * Presses a key once and waits until the game has read it and then read it let go, so that the
 * next press isn't read as the same one held down; or holds it for `holdMs`, as a player holds OK.
 */
export async function key(game: Page, name: string, holdMs?: number) {
  if (holdMs === undefined) {
    await game.evaluate(readOnce(name));
    await game.keyboard.press(name);
    await until(game, "window.rpgtlKeyRead");
  } else {
    await game.keyboard.down(name);
    await game.waitForTimeout(holdMs);
    await game.keyboard.up(name);
  }
  await until(game, `!Input._previousState[Input.keyMapper[${keyCodes[name]}]]`);
}

/** Waits until a window is open and takes input, then presses Enter in it. */
export async function confirm(game: Page, window: string) {
  await until(game, `${window}?.isOpen() && ${window}.active`);
  await key(game, "Enter");
}

/**
 * Moves the cursor of an open command window to `symbol` and picks it. It goes round up to three
 * times, since a slow frame can make one press move the cursor two places as the game catches up.
 */
export async function choose(game: Page, window: string, symbol: string) {
  await until(game, `${window}?.isOpen() && ${window}.active`);
  const count = await game.evaluate<number>(`${window}.maxItems()`);
  for (let i = 0; i < 3 * count; i++) {
    if ((await game.evaluate(`${window}.currentSymbol()`)) === symbol) return key(game, "Enter");
    const index = await game.evaluate<number>(`${window}.index()`);
    await key(game, "ArrowDown");
    await until(game, `${window}.index() !== ${index}`);
  }
  throw new Error(`${window} has no command ${symbol}`);
}

/** Waits for a message to finish writing and closes it. */
export async function closeMessage(game: Page) {
  // The window ignores input for 10 frames after the text ends.
  await until(game, `${messageWindow}.pause && !${messageWindow}._waitCount`);
  await key(game, "Enter");
}

/** Waits until the player stands still and no event or message runs. */
export const idle = (game: Page) =>
  until(game, "!$gamePlayer.isMoving() && !$gameMessage.isBusy() && !$gameMap.isEventRunning()");

/** Walks one tile per arrow key. */
export async function walk(game: Page, keys: string[]) {
  for (const name of keys) {
    await key(game, name);
    await idle(game);
  }
}

/** Picks New Game on the title screen and waits for the map. */
export async function newGame(game: Page) {
  await sceneIs(game, "Scene_Title");
  await choose(game, `${scene}._commandWindow`, "newGame");
  await sceneIs(game, "Scene_Map");
}

/** Saves to file 1 through the menu and goes back to the map. */
export async function saveFromMenu(game: Page) {
  await key(game, "Escape");
  await sceneIs(game, "Scene_Menu");
  await choose(game, `${scene}._commandWindow`, "save");
  await sceneIs(game, "Scene_Save");
  await confirm(game, `${scene}._listWindow`);
  await sceneIs(game, "Scene_Menu");
  await key(game, "Escape");
  await sceneIs(game, "Scene_Map");
}

/** Goes to the title screen through the menu and loads file 1. */
export async function loadFromTitle(game: Page) {
  await key(game, "Escape");
  await sceneIs(game, "Scene_Menu");
  await choose(game, `${scene}._commandWindow`, "gameEnd");
  await sceneIs(game, "Scene_GameEnd");
  await choose(game, `${scene}._commandWindow`, "toTitle");
  await sceneIs(game, "Scene_Title");
  await choose(game, `${scene}._commandWindow`, "continue");
  await sceneIs(game, "Scene_Load");
  await confirm(game, `${scene}._listWindow`);
  await sceneIs(game, "Scene_Map");
}

/** The game's console errors and uncaught exceptions, collected from now on. */
export function gameErrors(game: Page) {
  const errors: string[] = [];
  game.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  game.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Checks the engine shows no error screen and logged no error. */
export async function expectNoErrors(game: Page, errors: string[]) {
  await expect(game.locator("#ErrorPrinter")).toHaveText(/^$/);
  expect(errors).toEqual([]);
}
