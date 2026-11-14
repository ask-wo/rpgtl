// Opens the fixture by its path, reopens it from the sidebar and by its address, turns on Sharp
// pixels in Settings, and removes the game from the list.
import { existsSync, readFileSync } from "node:fs";

export default async ({ page, api, run, log }: any) => {
  await page.waitFor("#game-path");
  await page.shot("open-page");
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  const address = await page.eval("location.pathname");
  const id = address.slice("/games/".length);
  log(`opened at ${address}`);
  await page.waitUntil(
    `document.body.textContent.includes("1 image the game asks for isn't in its folder")`,
  );
  await page.shot("overview");

  await page.goto("/");
  await page.fill("#game-path", `${run.game}/index.html`);
  await page.clickText("Open");
  await page.waitUntil(`location.pathname === ${JSON.stringify(address)}`);
  if ((await api("games")).length !== 1) throw new Error("index.html opened a second game");

  await page.goto("/settings");
  await page.click(`[data-game-root="${run.game}"]`);
  await page.waitUntil(`location.pathname === ${JSON.stringify(address)}`);
  log("reopened from the sidebar");

  await page.goto(address);
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  log("the game's own address opens it after a reload");

  await page.clickText("Settings");
  await page.click('label[for="sharpPixels"]');
  await page.waitUntil(`document.querySelector("#sharpPixels").checked`);
  const settings = readFileSync(`${run.dir}/config/rpgtl/settings.json`, "utf8");
  log(`settings.json: ${settings}`);
  if (!/"sharpPixels": ?true/.test(settings)) throw new Error("Sharp pixels wasn't saved");
  await page.shot("settings");

  await page.goto(address);
  await page.click('[aria-label="Remove Fixture Adventure from the list"]');
  await page.clickText("Remove from list");
  await page.waitUntil(`location.pathname === "/"`);
  if ((await api("games")).length !== 0) throw new Error("the game is still listed");
  if (!existsSync(`${run.state}/games/${id}/catalog.json`))
    throw new Error("removing the game deleted its catalog");
  log("removed from the list, catalog kept");
  await page.shot("removed");
};
