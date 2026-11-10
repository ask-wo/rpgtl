import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
// Reads a generated picture with a fake reader, then checks the Images page's editor: the original
// next to the English drawn by the game's code, keeping a text or the whole image original, each
// saved as it is made, and an export that carries the read results, the erased images' patches
// and the run that read them.
// Run for MV and MZ: scripts/verify.sh image-view-mv MV examples/image-view.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { imageFixtureKey } from "../../../../packages/game/src/testUtils/fixture.ts";
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

const until = async (what: string, check: () => Promise<boolean>) => {
  for (let tries = 0; tries < 50; tries++) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`${what} didn't happen`);
};

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

  const lines = [line("开始游戏", [48, 48, 152, 82]), line("退出", [48, 118, 152, 152])];
  const reader = await fakeReader(run, lines);
  // White pixels left in the first block, and red pixels drawn around it, on the view's canvas.
  const canvasFacts = () =>
    page.eval(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[role="dialog"] canvas')!;
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
      let white = 0,
        red = 0;
      for (let y = 20; y < 100; y++)
        for (let x = 20; x < 380; x++) {
          const i = (y * data.width + x) * 4;
          const [r, g, b] = [data.data[i]!, data.data[i + 1]!, data.data[i + 2]!];
          if (x >= 50 && x < 150 && y >= 50 && y < 80 && r === 255 && g === 255 && b === 255)
            white++;
          if (r > 200 && g < 60 && b < 60) red++;
        }
      return { width: canvas.width, white, red };
    });
  const expectCanvas = async (what: string, drawn: boolean) => {
    await sleep(100);
    const facts = await canvasFacts();
    log(`${what}: ${JSON.stringify(facts)}`);
    const ok = drawn ? facts.white === 0 && facts.red > 0 : facts.white === 3000 && !facts.red;
    if (facts.width !== 400 || !ok) throw new Error(`${what}: ${JSON.stringify(facts)}`);
  };
  const served = async (id: string) =>
    (await (await fetch(`${run.url}/game/${id}/data/System.json`)).json()).rpgtlImageText?.[
      "img/pictures/Test"
    ];
  try {
    const id = await openImages(page, run);
    await readImages(page, api, id);
    await page.waitUntil(`document.querySelector('[aria-label="Images"] canvas')?.width === 400`);
    await page.shot("image-grid");
    await page.click('[aria-label="Open img/pictures/Test"]');
    await page.waitUntil(`document.querySelector('[role="dialog"] canvas')?.width === 400`);
    await page.shot("image-view-untranslated");
    await expectCanvas("untranslated", false);

    await page.fill(page.labelled("English for 开始游戏", "textarea"), "Begin");
    await expectCanvas("typed Begin", true);
    await until("Begin served", async () => (await served(id))?.blocks[0]?.text === "Begin");
    await page.shot("image-view-translated");

    await page.click('[role="dialog"] [role="group"][aria-label="开始游戏"] label');
    await expectCanvas("text kept original", false);
    await until("the kept text's save", async () => (await served(id)) === undefined);
    await page.click('[role="dialog"] [role="group"][aria-label="开始游戏"] label');
    await expectCanvas("text drawn again", true);

    await page.click('label[for="show-unchanged"]');
    await expectCanvas("whole image kept", false);
    await page.shot("image-view-whole-kept");
    await until(
      "the kept image's save",
      async () => (await api(`catalog?id=${id}`)).unchangedImages?.[0] === "img/pictures/Test",
    );
    if (await served(id)) throw new Error("the kept image is still drawn in the game");
    log("whole image kept: saved, and the game gets no blocks for it");

    // Back to drawn: the game gets the block again.
    await page.click('label[for="show-unchanged"]');
    await until("the block back", async () => (await served(id))?.blocks[0]?.text === "Begin");

    await page.press("Escape");
    await page.waitUntil(`!document.querySelector('[role="dialog"]')`);
    await page.goto(`/games/${id}`);
    await page.waitFor('label[for="translate-game"]');
    // Catch the exported file instead of downloading it.
    await page.eval(() => {
      const w = window as any;
      HTMLAnchorElement.prototype.click = function () {
        void fetch(this.href)
          .then((r) => r.text())
          .then((text) => (w.exported = text));
      };
    });
    await page.clickText("Export");
    await page.waitUntil("!!window.exported");
    const exported = JSON.parse(await page.eval("window.exported"));
    const image = exported.images?.["img/pictures/Test"];
    const imageRun = exported.imageRuns?.[image?.run];
    if (!image?.erased?.length || !imageRun)
      throw new Error("the export lacks the image text or its run");
    log(
      `export carries the read result, ${image.erased.length} patch(es) of its erased image and its run's models (${imageRun.detection}, ${imageRun.inpainting}, ${imageRun.images} image(s))`,
    );
    await page.shot("exported");
  } finally {
    reader.stop();
  }
};
