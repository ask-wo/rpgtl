import { assert, it } from "@effect/vitest";
import type { Catalog, ImageLine, ImageResult, PreparedBlock } from "@rpgtl/contracts";
import {
  entryTranslation,
  imageEntries,
  imageLimits,
  imageTextHints,
  withImageEntries,
} from "./index.ts";

type Box = readonly [number, number, number, number];

const readerLine = (text: string, box: Box): ImageLine => ({
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
  reader: "paddle",
});

const preparedBlock = (index: number, area: Box, space: Box, lineHeight = 16): PreparedBlock => ({
  lines: [index],
  grow: 0,
  polygons: [],
  area,
  lineHeight,
  space,
  fill: "#ffffff",
  outline: null,
  stroke: 0,
  weight: 0.12,
  bold: false,
  align: "centre",
  group: 0,
});

it("image limits count the characters that fit the free room of each prepared block", () => {
  const line = readerLine("鉴赏", [10, 10, 30, 26]);
  const result = (blocks?: ReadonlyArray<PreparedBlock>): ImageResult => ({
    file: "img/menus/Recalled.png",
    sha256: "a",
    width: 51,
    height: 51,
    lines: [line],
    ...(blocks && { blocks }),
  });
  const limits = (blocks?: ReadonlyArray<PreparedBlock>) =>
    imageLimits({ version: 1, images: { "img/menus/Recalled": result(blocks) } });
  const area: Box = [10, 10, 30, 26];
  // Width 20 + 2 * 10 = 40 px at 4 px per character is 10 characters on one row.
  const narrow = limits([preparedBlock(0, area, [0, 5, 40, 31])]);
  assert.deepStrictEqual(
    [...narrow.keys()],
    imageEntries({ version: 1, images: { "img/menus/Recalled": result() } }).map(
      (entry) => entry.id,
    ),
  );
  assert.deepStrictEqual([...narrow.values()], [10]);
  // Two rows fit in 16 + 2 * 12 = 40 px of height.
  assert.deepStrictEqual([...limits([preparedBlock(0, area, [0, -2, 40, 38])]).values()], [20]);
  // A column 20 px wide and 180 px tall runs sideways down its length: 180 px at 5 px per character.
  const column: Box = [-70, 90, 110, 110];
  assert.deepStrictEqual(
    [...limits([{ ...preparedBlock(0, column, column, 20), angle: 90 }]).values()],
    [36],
  );
  assert.strictEqual(limits().size, 0);
});

it("image limits give labels in a grid only the room the original takes", () => {
  const labels = [
    ["物攻", [10, 10, 30, 26]],
    ["魔攻", [60, 10, 80, 26]],
    ["物防", [10, 40, 30, 56]],
    ["魔防", [60, 40, 80, 56]],
  ] as const;
  const result = (count: number): ImageResult => ({
    file: "img/menus/Status.png",
    sha256: "a",
    width: 100,
    height: 70,
    lines: labels.slice(0, count).map(([text, box]) => readerLine(text, box)),
    blocks: labels
      .slice(0, count)
      .map(([, box], index) =>
        preparedBlock(index, box, [box[0] - 10, box[1], box[2] + 20, box[3]]),
      ),
  });
  const limits = (count: number) => [
    ...imageLimits({ version: 1, images: { "img/menus/Status": result(count) } }).values(),
  ];
  // 20 px at 4 px per character is 5 characters; a lone label also takes 10 px on each side.
  assert.deepStrictEqual(limits(4), [5, 5, 5, 5]);
  assert.deepStrictEqual(limits(1), [10]);
});

it("image text hints draw only translated blocks of images not kept original", () => {
  const lines = [readerLine("开始", [0, 0, 40, 16]), readerLine("退出", [0, 40, 40, 56])];
  const result = (file: string): ImageResult => ({
    file,
    sha256: "",
    width: 100,
    height: 100,
    lines,
    erased: `${file}.png`,
    blocks: [
      { ...preparedBlock(0, [0, 0, 40, 16], [0, 0, 100, 30]), bold: true },
      { ...preparedBlock(1, [0, 40, 40, 56], [0, 30, 100, 70]), fill: null },
    ],
  });
  const results = {
    version: 1 as const,
    images: { "img/pictures/A": result("a"), "img/pictures/B": result("b") },
  };
  const entries = imageEntries(results).map((entry) => ({
    ...entry,
    translation: { user: entry.source === "开始" ? "• Start" : "Quit" },
  }));
  const hints = imageTextHints(
    results,
    { entries, imageBold: "never", imageFont: "serif", unchangedImages: ["img/pictures/B"] },
    (file) => `/erased/${file}`,
  );
  assert.deepStrictEqual(Object.keys(hints), ["img/pictures/A"]);
  const hint = hints["img/pictures/A"];
  assert.strictEqual(hint?.erased, "/erased/a.png");
  assert.strictEqual(hint?.font, "serif");
  // The second block has no text colour to draw with.
  assert.deepStrictEqual(
    hint?.blocks.map((block) => [block.text, block.bold]),
    [["Start", false]],
  );
  const kept = entries.map((entry) => ({ ...entry, keepOriginal: entry.source === "开始" }));
  assert.deepStrictEqual(
    imageTextHints(results, { entries: kept }, (file) => file),
    {},
  );
});

it("image text keeps kana and Hangul lines whole, and only a short label before them goes", () => {
  const result: ImageResult = {
    file: "img/pictures/Notice.png",
    sha256: "a",
    width: 600,
    height: 400,
    lines: [
      readerLine("そう", [10, 10, 60, 40]),
      readerLine("A.はい", [10, 100, 90, 130]),
      readerLine("안녕", [10, 200, 60, 230]),
    ],
  };
  assert.deepStrictEqual(
    imageEntries({ version: 1, images: { "img/pictures/Notice": result } }).map(
      (entry) => entry.source,
    ),
    ["そう", "はい", "안녕"],
  );
});

const buttonResult = (file: string): ImageResult => ({
  file,
  sha256: "",
  width: 130,
  height: 30,
  lines: [readerLine("开始", [6, 0, 121, 30])],
  erased: `${file}.png`,
  blocks: [preparedBlock(0, [6, 0, 121, 30], [6, 0, 121, 30])],
});

it("image text hints give each image of a series the blocks of the others", () => {
  const results = {
    version: 1 as const,
    images: {
      "img/titles2/Command_0": buttonResult("c0"),
      "img/titles2/Command_1": buttonResult("c1"),
      "img/titles2/Command_2": buttonResult("c2"),
      "img/pictures/Command_3": buttonResult("p3"),
      "img/titles2/Commands": buttonResult("cs"),
    },
  };
  const entries = imageEntries(results).map((entry) => ({
    ...entry,
    translation: { user: entry.file.endsWith("1") ? "Load Game" : "Start" },
  }));
  const hints = imageTextHints(results, { entries }, (file) => file);
  assert.deepStrictEqual(
    hints["img/titles2/Command_0"]?.series?.map((blocks) => blocks.map((block) => block.text)),
    [["Load Game"], ["Start"]],
  );
  assert.notProperty(hints["img/pictures/Command_3"], "series");
  assert.notProperty(hints["img/titles2/Commands"], "series");
});

it("image limits give a centred label at one side of its space the room on the other side", () => {
  const limits = imageLimits({
    version: 1,
    images: {
      "img/titles2/Command_3": {
        ...buttonResult("c3"),
        lines: [readerLine("致谢", [6, 0, 67, 30])],
        blocks: [{ ...preparedBlock(0, [6, 0, 67, 30], [6, 0, 119, 30], 30) }],
      },
    },
  });
  // 113 px at 7.5 px per character.
  assert.deepStrictEqual([...limits.values()], [15]);
});

const labelButton = (file: string, source: string): ImageResult => ({
  ...buttonResult(file),
  lines: [readerLine(source, [6, 0, 121, 30])],
  blocks: [preparedBlock(0, [6, 0, 121, 30], [6, 0, 121, 30], 30)],
});

const limitsOf = (images: Record<string, ImageResult>) => [
  ...imageLimits({ version: 1, images }).values(),
];

it("image limits ask a menu's buttons for labels that fit at three quarters of their size", () => {
  // 115 px at 11.25 px per character for a menu, and at 7.5 for anything else.
  assert.deepStrictEqual(
    limitsOf({
      "img/titles1/Command_0": labelButton("c0", "开始冒险"),
      "img/titles1/Command_1": labelButton("c1", "读取存档"),
    }),
    [10, 10],
  );
  // Name plates repeat one name; labels of more than 4 characters aren't buttons.
  assert.deepStrictEqual(
    limitsOf({
      "img/pictures/Plate1": labelButton("p1", "白石千夏"),
      "img/pictures/Plate2": labelButton("p2", "白石千夏"),
      "img/hud/Item_1": labelButton("h1", "灯塔的钥匙"),
      "img/hud/Item_2": labelButton("h2", "渡口的船票"),
    }),
    [15, 15, 15, 15],
  );
});

const notice = (lines: ReadonlyArray<ImageLine>) => ({
  version: 1 as const,
  images: {
    "img/pictures/Notice": {
      file: "img/pictures/Notice.png",
      sha256: "a",
      width: 300,
      height: 200,
      lines: [...lines],
    },
  },
});

it("an image read again keeps the work on its texts whose lines or text changed", () => {
  const before = notice([
    readerLine("开始游戏", [10, 10, 90, 30]),
    readerLine("退出", [10, 100, 50, 120]),
    readerLine("设置", [10, 150, 50, 170]),
  ]);
  const catalog: Catalog = {
    version: 1,
    game: { id: "0123456789abcdef0123", title: "雨", engine: "MV" },
    translate: true,
    entries: [
      ...imageEntries(before).map((entry) => ({
        ...entry,
        translation: { user: { 开始游戏: "Start", 退出: "Quit", 设置: "" }[entry.source] ?? "" },
        ...(entry.source === "设置" && { keepOriginal: true }),
      })),
      {
        id: "m",
        file: "Map001.json",
        path: ["events"],
        source: "退出",
        translation: { user: "Leave" },
      },
    ],
    glossary: [],
  };
  // Read again, a stray line comes first, so every line's index and id changes, and 开始游戏 is
  // read as 开始游戏吧 now.
  const after = notice([
    readerLine("菜单", [200, 10, 240, 30]),
    readerLine("开始游戏吧", [10, 10, 100, 30]),
    readerLine("退出", [10, 100, 50, 120]),
    readerLine("设置", [10, 150, 50, 170]),
  ]);
  const entries = withImageEntries(catalog, after, before).entries;
  assert.deepStrictEqual(
    entries.map((entry) => [
      entry.source,
      entryTranslation(entry),
      entry.keepOriginal ?? false,
      entry.translation.guess?.flag ?? "",
    ]),
    [
      ["退出", "Leave", false, ""],
      ["开始游戏吧", "Start", false, "The image was read again; its text was 开始游戏."],
      ["菜单", "", false, ""],
      ["退出", "Quit", false, ""],
      ["设置", "", true, ""],
    ],
  );
  assert.deepStrictEqual(
    entries.slice(1).map((entry) => entry.id),
    imageEntries(after).map((entry) => entry.id),
  );
});

it("an image read again keeps a corrected text while it reads as before", () => {
  const before = notice([
    readerLine("退山", [10, 10, 90, 30]),
    readerLine("开使", [10, 100, 50, 120]),
  ]);
  const [quit, start] = imageEntries(before);
  if (!quit || !start) throw new Error("two entries expected");
  const catalog: Catalog = {
    version: 1,
    game: { id: "0123456789abcdef0123", title: "雨", engine: "MV" },
    translate: true,
    entries: [
      { ...quit, source: "退出", readerText: "退山", translation: { user: "Quit" } },
      {
        ...start,
        source: "开始",
        readerText: "开使",
        translation: { guess: { value: "Start", run: "r" } },
      },
    ],
    glossary: [],
  };
  assert.deepStrictEqual(withImageEntries(catalog, before, before).entries, catalog.entries);

  // Read again, a stray line comes first, so every id changes; 退山 reads as before, and 开使 is
  // read right now.
  const after = notice([
    readerLine("菜单", [200, 10, 240, 30]),
    readerLine("退山", [10, 10, 90, 30]),
    readerLine("开始", [10, 100, 50, 120]),
  ]);
  const entries = withImageEntries(catalog, after, before).entries;
  assert.deepStrictEqual(
    Object.fromEntries(
      entries.map((entry) => [
        entry.source,
        [entry.readerText, entryTranslation(entry), entry.translation.guess?.flag],
      ]),
    ),
    {
      退出: ["退山", "Quit", undefined],
      开始: [undefined, "Start", undefined],
      菜单: [undefined, "", undefined],
    },
  );
});
