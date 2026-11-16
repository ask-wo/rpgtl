// Moves the fixture's folder away: the sidebar asks for its new folder, choosing it keeps the
// game's id, and Delete then removes the game from the list and its state folder.
import { existsSync, readFileSync, renameSync } from "node:fs";

export default async ({ page, api, run, log }: any) => {
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  const address = await page.eval("location.pathname");
  const id = address.slice("/games/".length);
  const moved = `${run.game}-moved`;
  renameSync(run.game, moved);
  await page.goto(address);
  await page.waitUntil(`document.body.textContent.includes("Choose its new folder…")`);
  await page.shot("missing-folder");
  await page.clickText("Choose its new folder…");
  await page.waitFor('input[name="path"]');
  await page.fill('input[name="path"]', moved);
  await page.clickText("Go");
  await page.waitUntil(
    `document.querySelector('input[name="path"]')?.value === ${JSON.stringify(moved)}`,
  );
  await page.clickText("Choose this folder");
  await page.waitUntil(`!document.body.textContent.includes("Choose its new folder…")`);
  const games = await api("games");
  log(
    `after move: path ${await page.eval("location.pathname")}, games ${JSON.stringify(games.map((g: any) => [g.id, g.root]))}`,
  );
  if (games.length !== 1 || games[0].id !== id || games[0].root !== moved)
    throw new Error("the moved game didn't keep its id");
  await page.shot("moved-same-id");
  await page.click(`[aria-label="Remove Fixture Adventure from the list"]`);
  await page.clickText("Delete");
  await page.waitUntil(`location.pathname === "/"`);
  if ((await api("games")).length !== 0) throw new Error("Delete left the game listed");
  if (existsSync(`${run.state}/games/${id}`)) throw new Error("Delete left the game's folder");
  if (readFileSync(`${run.state}/games.json`, "utf8").includes(id))
    throw new Error("games.json still has the game");
  log("deleted: no game, no folder, not in games.json");
  await page.shot("deleted");
  renameSync(moved, run.game);
};
