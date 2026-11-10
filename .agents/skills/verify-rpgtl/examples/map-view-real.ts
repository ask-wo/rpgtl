// Opens the map view on MV's real engine, as a starting point for steps files that check the view
// where the engine behaves differently from the stubs. Run with verify.sh <name> real-MV. The checks
// of those differences (z-index, released keys, transfers, loaded saves) are
// e2e/mapViewRealMv.spec.ts (`pnpm run e2e`); map-view.ts covers the rest of the view on the stubbed
// MV and MZ fixtures.
import { closeMessage, engineError, idle, newGame, sceneIs } from "./real-mv.ts";

export default async ({ page, openPage, run }: any) => {
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  const id = (await page.eval("location.pathname")).slice("/games/".length);
  const game = await openPage(`/game/${id}/`);

  await sceneIs(game, "Scene_Title");
  await newGame(game);
  await closeMessage(game);
  await idle(game);
  await game.press("F7");
  await game.waitUntil('!document.querySelector("#rpgtl-map-view").hidden', 5000);
  await game.shot("map-view");
  await game.press("F7");
  if (await engineError(game)) throw new Error(await engineError(game));
};
