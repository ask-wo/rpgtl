// Opens the fixture, then a copy of it in another folder: RPGTL asks whether the copy is another
// version, and Replace moves the game there with its id, while Keep both lists a second game.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";

export default async ({ page, api, run, log }: any) => {
  const open = async (path: string) => {
    await page.goto("/");
    await page.fill("#game-path", path);
    await page.clickText("Open");
  };
  await open(run.game);
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  const address = await page.eval("location.pathname");
  log(`opened at ${address}`);

  const copy = join(dirname(run.game), "Fixture Adventure v2");
  cpSync(run.game, copy, { recursive: true });
  await open(copy);
  await page.waitUntil(`document.querySelector('[role="alertdialog"]') !== null`);
  const asked = await page.eval(
    `document.querySelector('[role="alertdialog"]').innerText.replace(/\\s+/g, " ")`,
  );
  log(`asked: ${asked}`);
  if (!asked.includes("(v2)")) throw new Error("the dialog doesn't name the copy's version");
  await page.shot("asked");

  await page.clickText("Don't open");
  await page.waitUntil(`document.querySelector('[role="alertdialog"]') === null`);
  if ((await api("games")).length !== 1) throw new Error("Don't open opened the copy");

  await open(copy);
  await page.waitUntil(`document.querySelector('[role="alertdialog"]') !== null`);
  await page.clickText("Replace");
  await page.waitUntil(`location.pathname === ${JSON.stringify(address)}`);
  const games = await api("games");
  log(`after Replace: ${JSON.stringify(games.map((game: any) => [game.id, game.root]))}`);
  if (games.length !== 1 || games[0].root !== copy) throw new Error("Replace didn't move the game");
  await page.shot("replaced");

  await open(run.game);
  await page.waitUntil(`document.querySelector('[role="alertdialog"]') !== null`);
  await page.clickText("Keep both");
  await page.waitUntil(
    `location.pathname.startsWith("/games/") && location.pathname !== ${JSON.stringify(address)}`,
  );
  if ((await api("games")).length !== 2) throw new Error("Keep both didn't list a second game");
  log(`kept both: ${await page.eval("location.pathname")}`);
};
