import { existsSync, readFileSync } from "node:fs";
import { entryTranslation } from "../../../../packages/domain/src/guesses.ts";
import { setTimeout as sleep } from "node:timers/promises";
// Reads a generated picture with a fake reader through the bar's Read new images, translates one of
// its two blocks on the Images page, and checks in the game tab that the engine's bitmap is drawn
// with the English before it is ready; then the lettering weight and Clear image text.
/* oxlint-disable no-shadow, no-underscore-dangle, unicorn/consistent-function-scoping --
   the functions passed to game.eval run in the page, so they can't use anything from this file. */
// Run for MV and MZ: scripts/verify.sh image-text-mv MV examples/image-text.ts
import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { imageFixtureKey } from "../../../../packages/game/src/testUtils/fixture.ts";

function chunk(name: string, bytes: Buffer) {
  const type = Buffer.from(name);
  const out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length);
  type.copy(out, 4);
  bytes.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([type, bytes])), bytes.length + 8);
  return out;
}
const rows: [number, number, number, number][] = [
  [50, 50, 150, 80],
  [50, 120, 150, 150],
];
// Grey, with a white rectangle standing in for the glyphs of each block.
export function picture(glyphs: boolean) {
  const [width, height] = [400, 200];
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const white =
        glyphs && rows.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1);
      raw.set(white ? [255, 255, 255, 255] : [128, 128, 128, 255], y * (width * 4 + 1) + 1 + x * 4);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
export function encrypt(png: Buffer) {
  const key = Buffer.from(imageFixtureKey, "hex");
  const body = Buffer.from(png);
  for (let i = 0; i < 16; i++) body[i] = body[i]! ^ key[i]!;
  return Buffer.concat([Buffer.from("RPGMV".padEnd(16, "\0")), body]);
}

/** The port of the fake reader: where launch.sh pointed the server's image reader. */
function readerPort(run: { readonly dir: string }) {
  return Number(new URL(readFileSync(path.join(run.dir, "reader-url"), "utf8").trim()).port);
}

/**
 * Answers RPGTL's image reader requests on the run's reader port: `/health` names made-up models,
 * `/read` finds `lines`, and `/prepare` erases them in red, bold and centred blocks.
 */
export async function fakeReader(
  run: { readonly dir: string },
  lines: { box: number[]; polygon: number[][] }[],
) {
  const answer = (pathname: string, body: any) =>
    pathname === "/health"
      ? {
          ocr: { detection: "fake-det", recognizers: { general: "fake-rec" } },
          inpaint: "fake-inpaint",
        }
      : pathname === "/read"
        ? { width: 400, height: 200, lines }
        : pathname === "/prepare"
          ? {
              erased: picture(false).toString("base64"),
              blocks: body.blocks.map((block: number[], group: number) => {
                const box = body.lines[block[0]].box;
                return {
                  polygons: [body.lines[block[0]].polygon],
                  area: box,
                  lineHeight: box[3] - box[1],
                  space: [20, box[1] - 28, 380, box[3] + 18],
                  fill: "#ff0000",
                  outline: null,
                  stroke: 0,
                  weight: 0.12,
                  bold: true,
                  align: "centre",
                  group,
                };
              }),
            }
          : {};
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");
    // /read sends the image itself; only /prepare sends JSON.
    const body = pathname === "/prepare" ? JSON.parse(await text(request)) : undefined;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(answer(pathname, body)));
  });
  await new Promise<void>((resolve) => server.listen(readerPort(run), "127.0.0.1", resolve));
  return {
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Opens the game, turns its translation on and shows its Images page; gives the game's id. */
export async function openImages(page: any, run: any) {
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  const id = (await page.eval("location.pathname")).slice("/games/".length);
  await page.click('label[for="translate-game"]');
  await page.waitFor('a[href$="/images"]');
  await page.click('a[href$="/images"]');
  await page.waitFor('[aria-label="Lettering preview"]');
  return id as string;
}

/** Reads the open game's images with the bar's Read new images and waits for the run. */
export async function readImages(page: any, api: any, id: string) {
  await page.clickText("Read new images");
  for (let i = 0; i < 100; i++) {
    const status = await api(`images/read?id=${id}`);
    if (status && ["Finished", "Stopped", "Failed"].includes(status.phase._tag)) {
      if (status.phase._tag !== "Finished" || status.failed.length)
        throw new Error(JSON.stringify(status));
      await page.waitUntil(`document.body.textContent.includes("Image reading done")`);
      return;
    }
    await sleep(100);
  }
  throw new Error("Image reading didn't end.");
}

const until = async (what: string, check: () => boolean) => {
  for (let tries = 0; tries < 50; tries++) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error(`${what} didn't happen`);
};

export default async ({ page, openPage, api, run, log }: any) => {
  const mz = existsSync(path.join(run.game, "js/rmmz_core.js"));
  const pictures = path.join(run.game, "img/pictures");
  await mkdir(pictures, { recursive: true });
  const system = JSON.parse(await readFile(path.join(run.game, "data/System.json"), "utf8"));
  await writeFile(
    path.join(run.game, "data/System.json"),
    JSON.stringify({ ...system, encryptionKey: imageFixtureKey }),
  );
  // The reader finds the encrypted copy; the fake engine loads the plain one by URL.
  await writeFile(path.join(pictures, `Test.${mz ? "png_" : "rpgmvp"}`), encrypt(picture(true)));
  await writeFile(path.join(pictures, "Test.png"), picture(true));
  await writeFile(path.join(pictures, "Other.png"), picture(true));

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
  const lines = [line("开始游戏", [48, 48, 152, 82]), line("退出", [48, 118, 152, 152])];
  const reader = await fakeReader(run, lines);
  const saved = (id: string) =>
    JSON.parse(readFileSync(`${run.state}/games/${id}/catalog.json`, "utf8"));
  try {
    const id = await openImages(page, run);
    await page.shot("opened");

    await readImages(page, api, id);
    await page.waitFor('[aria-label="Open img/pictures/Test"]');
    await page.shot("images-read");
    await page.click('[aria-label="Open img/pictures/Test"]');
    const box = page.labelled("English for 开始游戏", "textarea");
    await page.waitFor(box);
    await page.fill(box, "Begin");
    await until(
      "the typed English's save",
      () =>
        entryTranslation(saved(id).entries.find((entry: any) => entry.source === "开始游戏")) ===
        "Begin",
    );
    await page.press("Escape");
    await page.shot("translated");

    // Where the reader's results went.
    const served = await (await fetch(`${run.url}/game/${id}/data/System.json`)).json();
    const hint = served.rpgtlImageText?.["img/pictures/Test"];
    if (hint?.blocks.length !== 1 || hint.blocks[0].text !== "Begin")
      throw new Error(`System.json holds ${JSON.stringify(served.rpgtlImageText)}`);
    log(`System.json has one block for Test, erased ${hint.erased}`);

    const game = await openPage(`/game/${id}/`);
    await game.waitUntil(`document.readyState === "complete" && !!window.ImageManager`);
    const facts = await game.eval(async (gameId: string) => {
      const w = window as any;
      const system = await (await fetch(`/game/${gameId}/data/System.json`)).json();
      w.$dataSystem.rpgtlImageText = system.rpgtlImageText;
      const pixels = async (url: string) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height);
      };
      const bitmapPixels = (bitmap: any) =>
        bitmap.context.getImageData(
          0,
          0,
          bitmap.context.canvas.width,
          bitmap.context.canvas.height,
        );
      const original = await pixels("img/pictures/Test.png");
      const count = (
        data: ImageData,
        [x0, y0, x1, y1]: number[],
        test: (p: number[]) => boolean,
      ) => {
        let found = 0;
        for (let y = y0!; y < y1!; y++)
          for (let x = x0!; x < x1!; x++) {
            const i = (y * data.width + x) * 4;
            if (test([data.data[i]!, data.data[i + 1]!, data.data[i + 2]!, data.data[i + 3]!]))
              found++;
          }
        return found;
      };
      const white = (p: number[]) => p[0] === 255 && p[1] === 255 && p[2] === 255;
      const red = (p: number[]) => p[0]! > 200 && p[1]! < 60 && p[2]! < 60;
      const bitmap = w.ImageManager.loadBitmap("img/pictures/", "Test");
      const readyNow = bitmap.isReady();
      const atListener = new Promise<any>((resolve) =>
        bitmap.addLoadListener(() => {
          const data = bitmapPixels(bitmap);
          resolve({
            white: count(data, [50, 50, 150, 80], white),
            red: count(data, [20, 20, 380, 100], red),
          });
        }),
      );
      // Poll as fast as timers allow, and look at the pixels the moment the bitmap reports ready.
      let polls = 0;
      while (!bitmap.isReady() && polls < 5000) {
        polls++;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const first = bitmapPixels(bitmap);
      const firstReady = {
        white: count(first, [50, 50, 150, 80], white),
        red: count(first, [20, 20, 380, 100], red),
      };
      const data = bitmapPixels(bitmap);
      const listener = await atListener;
      let outside = 0;
      for (let y = 0; y < original.height; y++)
        for (let x = 0; x < original.width; x++) {
          if (x >= 42 && x < 158 && y >= 42 && y < 88) continue;
          const i = (y * original.width + x) * 4;
          if (data.data.slice(i, i + 4).some((value, k) => value !== original.data[i + k]))
            outside++;
        }
      const other = w.ImageManager.loadBitmap("img/pictures/", "Other");
      let otherFrames = 0;
      while (!other.isReady() && otherFrames < 600) {
        otherFrames++;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const otherData = bitmapPixels(other);
      return {
        readyNow,
        polls,
        firstReady,
        listener,
        size: [bitmap.width, bitmap.height],
        whiteLeft: count(data, [50, 50, 150, 80], white),
        redInSpace: count(data, [20, 20, 380, 100], red),
        secondBlockWhite: count(data, [50, 120, 150, 150], white),
        secondBlockSame: count(data, [50, 120, 150, 150], () => true),
        outside,
        otherSame: otherData.data.every((value: number, i: number) => value === original.data[i]),
        otherSize: [other.width, other.height],
        dirtied: bitmap.dirtied ?? bitmap._baseTexture?.updates ?? 0,
        url: bitmap.context.canvas.toDataURL("image/png"),
      };
    }, id);
    await writeFile(
      path.join(run.evidence, "drawn-bitmap.png"),
      Buffer.from(facts.url.split(",")[1], "base64"),
    );
    delete facts.url;
    log(JSON.stringify(facts));
    const expect = (ok: boolean, what: string) => {
      if (!ok) throw new Error(`${what}: ${JSON.stringify(facts)}`);
    };
    expect(facts.readyNow === false, "ready before loading");
    expect(facts.polls >= 1, "the bitmap was not ready for a poll");
    expect(
      facts.firstReady.white === 0 && facts.firstReady.red > 0,
      "undrawn when it first reported ready",
    );
    expect(facts.listener.white === 0 && facts.listener.red > 0, "undrawn when the listener ran");
    expect(facts.size[0] === 400 && facts.size[1] === 200, "size");
    expect(facts.whiteLeft === 0 && facts.redInSpace > 0, "first block");
    expect(facts.secondBlockWhite === 100 * 30, "second block's white rectangle");
    expect(facts.outside === 0, "pixels outside the grown mask");
    expect(facts.otherSame && facts.otherSize[0] === 400, "a bitmap not in rpgtlImageText");
    expect(facts.dirtied > 0, "texture update");
    await game.shot("game-tab");

    // The page's lettering weight is kept, and the game draws the English bold.
    await page.goto(`/games/${id}/images`);
    await page.waitFor("#lettering-weight");
    if (!(await page.text("#lettering-weight")).includes("Original weight"))
      throw new Error("The lettering weight does not start at Original weight");
    await page.shot("weight-default");
    await page.select("#lettering-weight", "Always bold");
    await until("the weight's save", () => saved(id).imageBold === "always");
    await page.goto(`/games/${id}/images`);
    await page.waitUntil(
      `document.querySelector("#lettering-weight")?.textContent.includes("Always bold")`,
    );
    await page.shot("weight-always");
    const hinted = await (await fetch(`${run.url}/game/${id}/data/System.json`)).json();
    if (hinted.rpgtlImageText["img/pictures/Test"].blocks[0].bold !== true) throw new Error("bold");
    log("Always bold saved, kept over a reload, and served to the game");

    // Clear image text asks, then deletes the reads, the erased images and the image entries.
    await page.clickText("Clear image text…");
    await page.waitFor('[role="alertdialog"]');
    await page.clickText("Clear image text", '[role="alertdialog"]');
    await page.waitUntil(`document.body.textContent.includes("Cleared the image text")`);
    if (saved(id).entries.some((entry: any) => entry.file.startsWith("img/")))
      throw new Error("image entries left after clearing");
    if (existsSync(`${run.state}/games/${id}/images.json`)) throw new Error("read results left");
    log("Clear image text removed the image entries and the read results");
    await page.shot("cleared");
  } finally {
    reader.stop();
  }
};
