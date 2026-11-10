import { expect, test } from "vite-plus/test";
import type { DrawBlock } from "@rpgtl/contracts";
import { layoutBlocks, type Measure } from "./lettering.ts";

// Every character is half as wide as the font is high, capitals reach 0.75 of the size above the
// baseline and descenders 0.2 below it.
const measure: Measure = (text, font) => {
  const size = Number(/(\d+)px/.exec(font)![1]);
  const descent = /[gjpqy]/.test(text) ? 0.2 * size : 0;
  return { width: 0.5 * size * text.length, ascent: 0.75 * size, descent };
};
const area: [number, number, number, number] = [100, 100, 300, 130];
const width = (text: string, size: number) => 0.5 * size * text.length;
function block(text: string, extra: Partial<DrawBlock> = {}, group = 0): DrawBlock {
  return {
    text,
    polygons: [],
    grow: 4,
    area,
    space: area,
    lineHeight: 30,
    fill: "#ffffff",
    outline: null,
    stroke: 0,
    bold: false,
    align: "centre",
    group,
    ...extra,
  };
}

test("Layout fits, widens, wraps and shrinks", () => {
  const sentence = "Begin a new adventure now";
  const [a, b, c, d] = layoutBlocks(
    [
      block("Start", {}, 1),
      block(sentence, { align: "left", space: [100, 60, 400, 170] }, 2),
      block(sentence, {}, 3),
      block(sentence, { space: [100, 60, 300, 170] }, 4),
    ],
    "GameFont",
    measure,
  );
  expect([a!.size, a!.lines.length]).toEqual([30, 1]);
  expect(a!.lines[0]!.x + width(a!.lines[0]!.text, 30) / 2).toBe(200);
  expect([b!.size, b!.lines.length, b!.lines[0]!.x]).toEqual([24, 1, 100]);
  expect([c!.size, c!.lines.map((line) => line.text)]).toEqual([16, [sentence]]);
  expect([d!.size, d!.lines.map((line) => line.text)]).toEqual([
    30,
    ["Begin a new", "adventure now"],
  ]);

  // Their own sizes would be 26, 23 and 12; the first two share the smaller one and the third,
  // far below the group's median, keeps its own.
  const group = layoutBlocks(
    [
      block("abcdefghijklmno", {}, 5),
      block("abcdefghijklmnopq", {}, 5),
      block("abcdefghijklmnopqrstuvwxyzabcdefg", {}, 5),
    ],
    "GameFont",
    measure,
  );
  expect(group.map((laid) => laid.size)).toEqual([23, 23, 12]);
});

test("A centred label at the left of its space grows to the right", () => {
  const [label] = layoutBlocks(
    [block("Acknowledgments", { area: [6, 0, 67, 30], space: [6, 0, 119, 30] })],
    "GameFont",
    measure,
  );
  // 113 px of room fits 15 characters at 15 px; the label's own 61 px fitted them at 8.
  expect([label!.size, label!.lines.map((line) => [line.text, line.x])]).toEqual([
    15,
    [["Acknowledgments", 6]],
  ]);
});

test("A menu's buttons drawn as separate images take one size, each on one line where it fits", () => {
  const button = (text: string) => [block(text, { area: [6, 0, 121, 30], space: [6, 0, 121, 30] })];
  const menu = ["Start Adventure", "Load Game", "Env. Settings", "Acknowledgments"].map(button);
  // On their own: Start Adventure wraps at 18, and Load Game, Env. Settings and Acknowledgments
  // fit on one line at 25, 17 and 15.
  expect(menu.map((blocks) => layoutBlocks(blocks, "GameFont", measure)[0]!.size)).toEqual([
    18, 25, 17, 15,
  ]);
  const laid = menu.map(
    (blocks, index) =>
      layoutBlocks(
        blocks,
        "GameFont",
        measure,
        menu.filter((_, other) => other !== index),
      )[0]!,
  );
  expect(laid.map(({ size, lines }) => [size, lines.length])).toEqual([
    [15, 1],
    [15, 1],
    [15, 1],
    [15, 1],
  ]);
  // A button of a far larger original keeps its own size.
  const [title] = layoutBlocks(
    [block("Title", { lineHeight: 60, area: [6, 0, 121, 60], space: [6, 0, 121, 60] })],
    "GameFont",
    measure,
    menu,
  );
  expect(title!.size).toBe(46);
});

const menuButton = (text: string) => [
  block(text, { area: [6, 0, 121, 30], space: [6, 0, 121, 30] }),
];

const menuSizes = (texts: ReadonlyArray<string>) => {
  const menu = texts.map(menuButton);
  return menu.map(
    (blocks, index) =>
      layoutBlocks(
        blocks,
        "GameFont",
        measure,
        menu.filter((_, other) => other !== index),
      )[0]!.size,
  );
};

test("A menu label at three quarters of the others' size shares theirs, and a far longer one keeps its own", () => {
  // On their own 30, 23, 28 and 30; Load Games is 77% of the median.
  expect(menuSizes(["Start", "Load Games", "Settings", "Credits"])).toEqual([23, 23, 23, 23]);
  // Acknowledgments fits at 15, half the median, and would shrink the rest.
  expect(menuSizes(["Start", "Load Games", "Settings", "Acknowledgments"])).toEqual([
    23, 23, 23, 15,
  ]);
});

const leftButton = (text: string, right: number) => [
  block(text, { area: [6, 0, right, 30], space: [6, 0, 121, 30] }),
];

const menuLefts = (images: ReadonlyArray<ReadonlyArray<DrawBlock>>) =>
  images.map(
    (blocks, index) =>
      layoutBlocks(
        blocks,
        "GameFont",
        measure,
        images.filter((_, other) => other !== index),
      )[0]!.lines[0]!.x,
  );

test("A menu whose labels all start at their images' left edge draws its English from there", () => {
  const menu = [
    leftButton("New Game", 121),
    leftButton("Settings", 121),
    leftButton("Credits", 67),
  ];
  expect(menuLefts(menu)).toEqual([6, 6, 6]);
  // Labels centred in their images start where their centres put them.
  const centred = [
    leftButton("New Game", 121),
    [block("Credits", { area: [30, 0, 97, 30], space: [6, 0, 121, 30] })],
  ];
  expect(menuLefts(centred).map((x) => x > 6)).toEqual([true, true]);
});

test("A turned block keeps its English centred among labels that start at one edge", () => {
  const turned = block("Ami", { area: [6, 0, 90, 30], space: [6, 0, 90, 30], angle: 90 });
  const menu = [leftButton("New Game", 121), leftButton("Credits", 67)];
  const [laid] = layoutBlocks([turned], "GameFont", measure, menu);
  expect(laid!.lines[0]!.x).toBe((96 - width("Ami", laid!.size)) / 2);
});
