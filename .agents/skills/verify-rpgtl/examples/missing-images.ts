// The overview's missing images: the warning lists an image the game asks for but lacks and says
// it shows blank, and a file that differs only in letter case counts as there.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { picture } from "./image-text.ts";

export default async ({ page, run }: any) => {
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.body.textContent.includes("img/characters/Actor1")`);
  await page.waitUntil(`document.body.textContent.includes("Replaced with a blank image.")`);
  await page.shot("missing");

  mkdirSync(path.join(run.game, "img/characters"), { recursive: true });
  writeFileSync(path.join(run.game, "img/characters/actor1.png"), picture(false));
  await page.goto("/");
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  await page.waitUntil(`!document.body.textContent.includes("img/characters/Actor1")`);
  await page.shot("found-in-other-case");
};
