// The overview's missing images: the warning lists an image the game asks for but lacks and says
// it shows blank, and a file that differs only in letter case counts as there.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export default async ({ page, run }: any) => {
  const sprite = path.join(run.game, "img/characters/Actor1.png");
  const sheet = readFileSync(sprite);
  rmSync(sprite);
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(
    `document.body.textContent.includes("img/characters/Actor1, asked for in Actors.json, Map002.json")`,
  );
  await page.waitUntil(`document.body.textContent.includes("Replaced with a blank image.")`);
  await page.shot("missing");

  writeFileSync(path.join(run.game, "img/characters/actor1.png"), sheet);
  await page.goto("/");
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  await page.waitUntil(`!document.body.textContent.includes("img/characters/Actor1")`);
  await page.shot("found-in-other-case");
};
