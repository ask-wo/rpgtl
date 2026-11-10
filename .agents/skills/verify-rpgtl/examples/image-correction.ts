// Corrects a misread text in the Images page's editor: the entry keeps its id and the English typed
// for it, reading the image again keeps the correction while the text reads the same, and the text
// read restores it.
// Run: scripts/verify.sh image-correction MV examples/image-correction.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { imageFixtureKey } from "../../../../packages/game/src/testUtils/fixture.ts";
import { entryTranslation } from "../../../../packages/domain/src/guesses.ts";
import { encrypt, fakeReader, openImages, picture, readImages } from "./image-text.ts";

const line = (text: string, box: number[]) => ({
  text,
  score: 0.99,
  contrast: 255,
  box,
  polygon: [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[2], box[3]],
    [box[0], box[3]],
  ],
});

const group = (text: string) => `[role="dialog"] [role="group"][aria-label="${text}"]`;

export default async ({ page, api, run, log }: any) => {
  const pictures = path.join(run.game, "img/pictures");
  await mkdir(pictures, { recursive: true });
  const system = JSON.parse(await readFile(path.join(run.game, "data/System.json"), "utf8"));
  await writeFile(
    path.join(run.game, "data/System.json"),
    JSON.stringify({ ...system, encryptionKey: imageFixtureKey }),
  );
  const mz = existsSync(path.join(run.game, "js/rmmz_core.js"));
  await writeFile(path.join(pictures, `Test.${mz ? "png_" : "rpgmvp"}`), encrypt(picture(true)));
  const reader = await fakeReader(run, [
    line("开始游戏", [48, 48, 152, 82]),
    line("退山", [48, 118, 152, 152]),
  ]);
  const saved = async (id: string) =>
    (await api(`catalog?id=${id}`)).entries.find(
      (e: any) => e.file === "img/pictures/Test" && e.path[1] === "1",
    );
  try {
    const id = await openImages(page, run);
    await readImages(page, api, id);
    await page.click('[aria-label="Open img/pictures/Test"]');
    await page.waitFor(group("退山"));
    const read = await saved(id);
    await page.fill(page.labelled("English for 退山", "textarea"), "Quit");
    await page.waitUntil(`document.body.textContent.includes("All changes saved")`);
    await page.click(page.labelled("Correct 退山", "button"));
    await page.fill(page.labelled("Text in the image for 退山", "textarea"), "退出");
    await page.shot("correcting");
    await page.clickText("Save", '[role="dialog"]');
    await page.waitFor(group("退出"));
    for (let tries = 0; (await saved(id)).source !== "退出"; tries++) {
      if (tries > 50) throw new Error("the correction wasn't saved");
      await sleep(100);
    }
    const corrected = await saved(id);
    log(`entry after correction: ${JSON.stringify(corrected)}`);
    if (
      corrected.id !== read.id ||
      corrected.readerText !== "退山" ||
      entryTranslation(corrected) !== "Quit"
    )
      throw new Error("the entry didn't keep its id, the text read and the typed English");
    await page.shot("corrected");

    await page.clickText("Read again", '[role="dialog"]');
    for (let tries = 0; tries < 100; tries++) {
      const status = await api(`images/read?id=${id}`);
      if (status && ["Finished", "Stopped", "Failed"].includes(status.phase._tag)) break;
      await sleep(100);
    }
    await page.waitFor(group("退出"));
    const reread = await saved(id);
    log(`after read again: ${JSON.stringify(reread)}`);
    if (reread.source !== "退出" || reread.readerText !== "退山")
      throw new Error("reading the image again lost the correction");
    await page.shot("read-again");

    await page.clickText("Use it", group("退出"));
    await page.waitFor(group("退山"));
    for (let tries = 0; (await saved(id)).readerText !== undefined; tries++) {
      if (tries > 50) throw new Error("going back to the text read wasn't saved");
      await sleep(100);
    }
    const restored = await saved(id);
    log(`after Use it: ${JSON.stringify(restored)}`);
    if (restored.source !== "退山" || entryTranslation(restored) !== "Quit")
      throw new Error("the text read didn't come back with the typed English");
    await page.shot("restored");
  } finally {
    reader.stop();
  }
};
