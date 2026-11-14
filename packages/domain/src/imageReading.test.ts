import { assert, it } from "@effect/vitest";
import type { Box, ImageLine, ImageResult } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import {
  decryptImage,
  doubtfulLines,
  imageBlocks,
  imagePlan,
  keptLine,
  linesPrompt,
  mergeQwenLines,
  needsFallback,
  partialRead,
  preparedVersion,
  qwenCrops,
  qwenImageLines,
  readVersion,
  contrastVersion,
  textImages,
  xpTextImages,
  withDoubledLines,
} from "./index.ts";

const line = (text: string, box: Box, contrast = 255, score = 0.99): ImageLine => ({
  text,
  score,
  contrast,
  box,
  polygon: [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[2], box[3]],
    [box[0], box[3]],
  ],
  reader: "paddle",
});
const size = { width: 1120, height: 630 };

it("text images are the text folders without the engine's icon sheets, the game's own folders and the parallaxes maps draw signs on, never tilesets", () => {
  const files = [
    "img/pictures/nested/Background.png_",
    "img/system/menus/Window.png_",
    "img/system/Balloon.png_",
    "img/system/IconSet.png_",
    "img/system/ButtonSet.png_",
    "img/system/MadeWithMv.png_",
    "img/system/GameOver.png_",
    "img/titles1/chapters/Title.png_",
    "img/widget-ui/panels/actions/Confirm.png_",
    "img/characters/Actor.png_",
    "img/tilesets/Town.png_",
    "img/parallaxes/!Camp.png_",
    "img/parallaxes/Sky.png_",
    "img/tilesets/Outside_A1.png_",
    "img/tilesets/Signs.png_",
    "img/widget-ui/panels/actions/Unencrypted.png",
    "img/widget-ui/panels/actions/WrongEngine.rpgmvp",
    "img/Loose.png_",
  ];
  const images = textImages({
    extension: ".png_",
    files,
    maps: [{ events: [], parallaxName: "!Camp", tilesetId: 1 }],
  });
  assert.deepStrictEqual(
    images.map(({ image }) => image),
    [
      "img/pictures/nested/Background",
      "img/titles1/chapters/Title",
      "img/system/ButtonSet",
      "img/system/GameOver",
      "img/system/menus/Window",
      "img/widget-ui/panels/actions/Confirm",
      "img/parallaxes/!Camp",
    ],
  );
  assert.strictEqual(images[0]?.file, "img/pictures/nested/Background.png_");
});

it("an XP game's text images are its pictures, titles, game overs and folders of its own", () => {
  const images = xpTextImages([
    "Graphics/Pictures/Sign.png",
    "Graphics/Battlers/Slime.png",
    "Graphics/Titles/Cover.jpg",
    "Graphics/Menus/Banner.png",
    "Graphics/pictures/sign.PNG",
    "Graphics/Pictures/Board.jpg",
    "Graphics/Pictures/Board.png",
    "Graphics/Gameovers/End.png",
    "Graphics/Windowskins/Frame.png",
    "Graphics/Pictures/Notes.txt",
    "Graphics/Loose.png",
    "Graphics/RPGTL/0a1b2c.png",
    "Audio/SE/Bell.png",
  ]);
  assert.deepStrictEqual(images, [
    { image: "Graphics/Pictures/Board", file: "Graphics/Pictures/Board.png" },
    { image: "Graphics/Pictures/Sign", file: "Graphics/Pictures/Sign.png" },
    { image: "Graphics/Titles/Cover", file: "Graphics/Titles/Cover.jpg" },
    { image: "Graphics/Gameovers/End", file: "Graphics/Gameovers/End.png" },
    { image: "Graphics/Menus/Banner", file: "Graphics/Menus/Banner.png" },
  ]);
});

it("a folder's files sort where the folder sorts among its siblings", () => {
  const images = textImages({
    extension: ".png",
    files: ["img/pictures/b.png", "img/pictures/a/z.png", "img/pictures/c.png"],
    maps: [],
  });
  assert.deepStrictEqual(
    images.map(({ image }) => image),
    ["img/pictures/a/z", "img/pictures/b", "img/pictures/c"],
  );
});

it("an encrypted image is decrypted with the game's key, and anything else is refused", () => {
  const key = "0123456789abcdef0123456789abcdef";
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const header = new TextEncoder().encode("RPGMV\0\0\0\0\0\0\0\0\0\0\0");
  const payload = png.slice();
  for (let index = 0; index < 16; index++)
    payload[index] =
      (payload[index] ?? 0) ^ Number.parseInt(key.slice(2 * index, 2 * index + 2), 16);
  const encrypted = Uint8Array.from([...header, ...payload]);
  assert.deepStrictEqual(Result.getOrThrow(decryptImage(encrypted, key)), png);
  assert.deepStrictEqual(Result.getOrThrow(decryptImage(png, undefined)), png);
  assert.deepStrictEqual(decryptImage(encrypted, undefined), Result.fail("encryptionKey"));
  assert.deepStrictEqual(decryptImage(encrypted, "f".repeat(32)), Result.fail("notAnImage"));
});

it("decrypting a file read into a Node Buffer leaves its bytes as they were, so it decrypts again", () => {
  const key = "0123456789abcdef0123456789abcdef";
  const header = new TextEncoder().encode("RPGMV\0\0\0\0\0\0\0\0\0\0\0");
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const payload = png.map((byte, index) =>
    index < 16 ? byte ^ Number.parseInt(key.slice(2 * index, 2 * index + 2), 16) : byte,
  );
  const file = Buffer.from([...header, ...payload]);
  assert.deepStrictEqual(Result.getOrThrow(decryptImage(file, key)), png);
  assert.deepStrictEqual(Result.getOrThrow(decryptImage(file, key)), png);
});

it("the stronger footer watermark is skipped while wanted dim lettering stays", () => {
  const result = {
    ...size,
    lines: [
      line("森林女王", [327, 482, 436, 513], 229),
      line("戏", [331, 552, 362, 568], 24),
      line("作", [547, 550, 593, 572], 11),
      line("所", [703, 551, 728, 573], 11),
      line("牟", [800, 595, 825, 616], 14),
      line("有", [833, 550, 860, 571], 15),
      line("灰色文字", [100, 300, 400, 330], 21),
    ],
  };
  assert.deepStrictEqual(imageBlocks(result), [[6], [0]]);
  assert.isFalse(partialRead(result));
  assert.lengthOf(imageBlocks({ ...result, includeFaint: true }).flat(), 7);
  const single = line("金", [100, 100, 120, 120], 21);
  assert.isFalse(partialRead({ ...result, lines: [single] }));
  assert.isTrue(partialRead({ ...result, lines: [single, line("币", [125, 100, 145, 120], 21)] }));
});

it("Latin letters touching Chinese count as a partial read, and Qwen's whole line replaces the piece", () => {
  const level = line("一级", [922, 48, 949, 69]);
  const paddle = { ...size, lines: [line("OT-", [879, 47, 925, 69]), level] };
  assert.isTrue(partialRead(paddle));
  assert.isFalse(partialRead({ ...paddle, lines: [line("HP", [700, 47, 730, 69]), level] }));

  const qwen = [{ ...line("下一级", [875, 45, 950, 70]), reader: "qwen" as const }];
  const crops = qwenCrops(paddle, qwen);
  assert.deepStrictEqual(crops, [{ index: 0, crop: [843, 13, 982, 102] }]);
  const crop = { ...size, lines: [line("OT一级", [868, 40, 952, 74])] };
  const merged = mergeQwenLines(paddle, qwen, new Map([[0, crop]]));
  assert.deepStrictEqual(
    merged.lines.map((found) => [found.text, found.box]),
    [["下一级", [879, 47, 949, 69]]],
  );

  // Qwen puts the line a few characters to the left and the crop finds none of it, so Paddle's
  // pieces beside it give its place and go.
  const moved = mergeQwenLines(
    { ...paddle, lines: [...paddle.lines, line("生命", [100, 300, 140, 322])] },
    [{ ...line("下一级", [824, 56, 867, 76]), reader: "qwen" }],
    new Map([[0, { ...size, lines: [] }]]),
  );
  assert.deepStrictEqual(
    moved.lines.map((found) => [found.text, found.box, found.rough]),
    [
      ["生命", [100, 300, 140, 322], undefined],
      ["下一级", [879, 47, 949, 69], undefined],
    ],
  );
});

it("a Qwen line its crop places exactly takes the crop's outline, and one it can't place is rough", () => {
  const paddle = { ...size, lines: [line("菲奥娜", [100, 100, 400, 130])] };
  const qwen = qwenImageLines(
    {
      lines: [
        { text: "菲奥娜", bbox_2d: [89, 159, 357, 206] },
        { text: "此游戏的版权归属作者所有", bbox_2d: [222, 875, 685, 909] },
        { text: "新的文字", bbox_2d: [100, 300, 400, 340] },
      ],
    },
    size,
  );
  const exact = line("此游戏的版权归属作者所有", [250, 551, 767, 574]);
  const merged = mergeQwenLines(
    paddle,
    qwen,
    new Map([
      [1, { ...size, lines: [exact] }],
      [2, { ...size, lines: [] }],
    ]),
  );
  assert.deepStrictEqual(
    merged.lines.map((found) => [found.text, found.reader, found.box, found.rough]),
    [
      ["菲奥娜", "paddle", [100, 100, 400, 130], undefined],
      ["此游戏的版权归属作者所有", "qwen", [250, 551, 767, 574], undefined],
      ["新的文字", "qwen", [99, 176, 461, 227], true],
    ],
  );
});

it("Qwen is asked about single characters, and every line of map artwork", () => {
  const result = {
    ...size,
    lines: [
      { ...line("方", [524, 274, 570, 328]), score: 0.95 },
      line("级", [100, 100, 124, 124]),
      line("物品", [200, 100, 248, 124]),
      line("7人", [300, 100, 348, 124]),
    ],
  };
  assert.deepStrictEqual(
    doubtfulLines("img/pictures/Status", result).map(({ text }) => text),
    ["方", "级", "7人"],
  );
  assert.deepStrictEqual(doubtfulLines("img/parallaxes/!Town", result), result.lines);
});

it("kana and Hangul count like Chinese characters in small lettering read at twice the size, single characters and pieces of a line", () => {
  const enlarged = (text: string, box: Box): ImageLine => ({ ...line(text, box), enlarged: true });
  const result = {
    ...size,
    lines: [
      enlarged("ひみつのちず", [380, 222, 470, 237]),
      enlarged("새로운 모험", [380, 300, 470, 315]),
      line("け", [100, 100, 124, 124]),
      line("이", [600, 100, 624, 124]),
    ],
  };
  assert.isTrue(result.lines.every((found) => keptLine(found, result)));
  assert.deepStrictEqual(
    doubtfulLines("img/pictures/Map", result).map(({ text }) => text),
    ["け", "이"],
  );
  assert.isTrue(
    partialRead({
      ...size,
      lines: [line("ま", [100, 100, 120, 120]), line("ち", [125, 100, 145, 120])],
    }),
  );
  assert.include(linesPrompt("korean"), "including Korean and Latin text");
});

it("full-size images keep the lines only the read at twice their size found, marked enlarged", () => {
  const name = line("藤原·美咲", [57, 157, 256, 213]);
  const doubled = withDoubledLines(
    { ...size, lines: [name] },
    {
      ...size,
      lines: [
        { ...name, box: [56, 156, 257, 214] },
        line("喜欢读书的高中男生", [380, 222, 515, 237]),
      ],
    },
  );
  assert.deepStrictEqual(
    doubled.lines.map((found) => [found.text, found.enlarged]),
    [
      ["藤原·美咲", undefined],
      ["喜欢读书的高中男生", true],
    ],
  );
});

it("a run reads changed and outdated images again and prepares saved reads whose blocks changed", () => {
  const lines = [line("开始游戏", [100, 100, 400, 130])];
  const saved: ImageResult = {
    file: "img/pictures/Notice.png",
    sha256: "a",
    ...size,
    lines,
    blocks: [],
    readVersion,
    contrastVersion,
    preparedVersion,
    includeFaint: false,
  };
  const options = { sha256: "a", includeFaint: false, fallback: false };
  const plan = (result: ImageResult | undefined, changes: Partial<typeof options> = {}) =>
    imagePlan("img/pictures/Notice", result, { ...options, ...changes });
  assert.strictEqual(plan(undefined), "read");
  assert.strictEqual(plan(saved, { sha256: "b" }), "read");
  assert.strictEqual(plan({ ...saved, readVersion: 3 }), "read");
  assert.strictEqual(plan({ ...saved, error: "Broken" }), "read");
  // The saved blocks are none, but the line is text now.
  assert.strictEqual(plan(saved), "again");
  const prepared = { ...saved, blocks: [] as ImageResult["blocks"] & object };
  const kept = { ...prepared, lines: [] };
  assert.strictEqual(plan(kept), "keep");
  assert.strictEqual(plan(kept, { includeFaint: true }), "again");
  assert.strictEqual(plan({ ...kept, contrastVersion: 1 }), "again");
  const { blocks: _blocks, ...unprepared } = kept;
  assert.strictEqual(plan(unprepared), "read");
  const doubtful = { ...unprepared, lines: [line("方", [524, 274, 570, 328])] };
  assert.strictEqual(plan({ ...doubtful, blocks: [] }, { fallback: true }), "again");
  assert.strictEqual(plan(doubtful, { fallback: true }), "fallback");
  assert.strictEqual(plan({ ...doubtful, fallback: "vision" }, { fallback: true }), "read");
});

it("a button whose lettering already has its English beside it stays as it is, its artwork's lettering too", () => {
  const button = {
    width: 121,
    height: 160,
    lines: [
      line("店", [21, 22, 29, 33]),
      line("继续冒险", [19, 82, 99, 106]),
      line("Go", [18, 111, 45, 126]),
      line("On", [51, 112, 101, 126]),
    ],
  };
  assert.deepStrictEqual(imageBlocks(button), []);
  assert.isFalse(needsFallback("img/titles2/Command_0", button));
  const banner = {
    ...size,
    lines: [line("VICTORY", [397, 190, 719, 261]), line("胜利", [422, 274, 694, 358])],
  };
  assert.deepStrictEqual(imageBlocks(banner), []);
});

it("English beside only some of an image's lettering, or a short label off to one side, leaves it to translate", () => {
  const status = {
    ...size,
    lines: [
      line("林·小雨", [236, 27, 344, 50]),
      line("EXP", [219, 54, 263, 73]),
      line("背包里的物品", [448, 106, 553, 130]),
    ],
  };
  assert.deepStrictEqual(imageBlocks(status), [[0], [2]]);
  const guide = {
    ...size,
    lines: [
      line("设置", [100, 20, 160, 44]),
      line("Settings", [96, 48, 164, 66]),
      line("在这里调整音量和画面", [100, 120, 400, 144]),
    ],
  };
  assert.deepStrictEqual(imageBlocks(guide), [[0], [2]]);
});
