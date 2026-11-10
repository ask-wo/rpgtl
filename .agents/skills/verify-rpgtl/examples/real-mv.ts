// Starts the real-MV game and shows its intro message, as a starting point for steps files that
// play MV's real engine. Run with verify.sh <name> real-MV. The helpers drive the game the way a
// player does; other steps files import them. e2e/realMv.ts has the same helpers for Playwright: a
// fix to one belongs in the other too. The checks of playing it through, saving and loading
// are e2e/playRealMv.spec.ts (`pnpm run e2e`).

const scene = "SceneManager._scene";
const messageWindow = `${scene}._messageWindow`;

/** Waits until the scene is `name` (a class such as "Scene_Map") and has finished starting. */
export const sceneIs = (game: any, name: string) =>
  game.waitUntil(`${scene}?.constructor === ${name} && ${scene}.isActive()`, 20000);

/** The key codes of the keys the steps press, which MV's `Input.keyMapper` turns into buttons. */
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
 * it falls behind, so a slow driver can hold a key past the 24 updates after which MV repeats it.
 * The key still goes down through the browser, so a key RPGTL keeps from the game is never read.
 */
const readOnce = (code: number) => `(() => {
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

/**
 * Presses a key once and waits until the game has read it and then read it let go, so that the
 * next press isn't read as the same one held down.
 */
export async function key(game: any, name: string) {
  const code = keyCodes[name];
  if (code === undefined) throw new Error(`No key code for ${name}`);
  await game.eval(readOnce(code));
  await game.press(name);
  await game.waitUntil("window.rpgtlKeyRead", 10000, `the game reads ${name}`);
  await game.waitUntil(`!Input._previousState[Input.keyMapper[${code}]]`, 10000);
}

/** Waits until a window is open and takes input, then presses Enter in it. */
export async function confirm(game: any, window: string) {
  await game.waitUntil(`${window}?.isOpen() && ${window}.active`, 10000);
  await key(game, "Enter");
}

/** Moves the cursor of an open command window to `symbol` and picks it. */
export async function choose(game: any, window: string, symbol: string) {
  await game.waitUntil(`${window}?.isOpen() && ${window}.active`, 10000);
  const count = await game.eval(`${window}.maxItems()`);
  for (let i = 0; i < count; i++) {
    if ((await game.eval(`${window}.currentSymbol()`)) === symbol) return key(game, "Enter");
    const index = await game.eval(`${window}.index()`);
    await key(game, "ArrowDown");
    await game.waitUntil(`${window}.index() !== ${index}`, 5000);
  }
  throw new Error(`${window} has no command ${symbol}`);
}

/** Waits for a message to finish writing and closes it. */
export async function closeMessage(game: any) {
  // The window ignores input for 10 frames after the text ends.
  await game.waitUntil(`${messageWindow}.pause && !${messageWindow}._waitCount`, 10000);
  await key(game, "Enter");
}

/** Waits until the player stands still and no event or message runs. */
export const idle = (game: any) =>
  game.waitUntil(
    "!$gamePlayer.isMoving() && !$gameMessage.isBusy() && !$gameMap.isEventRunning()",
    10000,
  );

/** Walks one tile per arrow key. */
export async function walk(game: any, keys: string[]) {
  for (const name of keys) {
    await key(game, name);
    await idle(game);
  }
}

/** Picks New Game on the title screen and waits for the map. */
export async function newGame(game: any) {
  await sceneIs(game, "Scene_Title");
  await choose(game, `${scene}._commandWindow`, "newGame");
  await sceneIs(game, "Scene_Map");
}

/** The engine's error screen text, empty while the game runs. */
export const engineError = (game: any) =>
  game.eval("document.querySelector('#ErrorPrinter')?.textContent ?? ''");

export default async ({ page, openPage, run, log }: any) => {
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  const id = (await page.eval("location.pathname")).slice("/games/".length);

  const game = await openPage(`/game/${id}/`);
  await sceneIs(game, "Scene_Title");
  await game.shot("title");
  await newGame(game);
  await game.waitUntil(`${messageWindow}.pause`, 10000);
  log("intro message " + (await game.eval("$gameMessage.allText()")));
  await game.shot("intro");
  await closeMessage(game);
  await idle(game);
  if (await engineError(game)) throw new Error(await engineError(game));
};
