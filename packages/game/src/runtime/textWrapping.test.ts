import { test, expect } from "vite-plus/test";
import { loadRuntime } from "../testUtils/fixture.ts";

test("runtime wraps long messages inside the window next to a face and an icon", async () => {
  for (const engine of ["MV", "MZ"] as const) {
    const { message } = await loadRuntime(engine);
    message.face = true;
    const text = "\\C[2]Hello\\C[0] there \\I[64] friend, this is a long line.\nSecond line.";
    const lines = message.convertEscapeCharacters(text).split("\n");
    // 232px left: 23 characters, and the icon takes 36px.
    expect(lines).toEqual([
      "\x1bC[2]Hello\x1bC[0] there \x1bI[64]",
      "friend, this is a long",
      "line.",
      "Second line.",
    ]);
  }
});

for (const engine of ["MV", "MZ"] as const)
  test(`runtime fits translated picture dialogue and resets its position in ${engine}`, async () => {
    const source = {
      top: 1,
      indent: "        ",
      widest: ["The source has a fixed text area", "that is two lines tall."],
      rows: 2,
    };
    const { message } = await loadRuntime(engine, {
      $dataSystem: {
        rpgtlMessageLayouts: {
          "A translation with many words that takes up much more room": source,
        },
      },
    });
    message.contents.height = 72;
    const translated = "A translation with many words that takes up much more room";
    const wrapped = message.convertEscapeCharacters(translated);
    const layout = (message as any)._rpgtlMessageLayout;
    const top = layout.top;
    const start = message.newLineX({ rtl: false });
    const fittedSize = message.contents.fontSize;
    message.contents.fontSize = 28;
    const originalRight =
      start +
      Math.max(
        message.textWidth("The source has a fixed text area"),
        message.textWidth("that is two lines tall."),
      );
    message.contents.fontSize = fittedSize;
    expect(start).toBeGreaterThan(0);
    // One row of the frame holds a third of the text even at the smallest size.
    expect(message.contents.fontSize).toBe(24);
    expect(wrapped.split("\f")).toHaveLength(3);
    for (const line of wrapped.split(/[\n\f]/))
      expect(start + message.textWidth(line)).toBeLessThanOrEqual(originalRight);
    expect(layout).toMatchObject({ start, top });

    message.contents.height = 200;
    const state = { x: 12, y: 0, startX: 12, startY: 0 };
    message.newPage(state);
    expect(state).toMatchObject({ x: start, y: top, startX: start, startY: top });
    expect(
      message.needsNewPage({
        index: 1,
        text: "translated message",
        y: layout.bottom - 10,
        height: 10,
      }),
    ).toBe(false);
    expect(
      message.needsNewPage({
        index: 1,
        text: "translated message",
        y: layout.bottom - 9,
        height: 10,
      }),
    ).toBe(true);
    expect(
      message.needsNewPage({
        index: "finished".length,
        text: "finished",
        y: layout.bottom + 1,
        height: 10,
      }),
    ).toBe(false);
    for (let page = 0; page < 3; page++) {
      const repeated = { x: 0, y: 99, startX: 0, startY: 99 };
      message.newPage(repeated);
      expect(repeated).toMatchObject({ x: start, y: top, startX: start, startY: top });
    }

    message._textState = { text: wrapped };
    message.convertEscapeCharacters("Text a plugin measures while the message shows");
    expect((message as any)._rpgtlMessageLayout).toBe(layout);
    message._textState = null;

    message.convertEscapeCharacters("A normal next message");
    expect((message as any)._rpgtlMessageLayout).toBeUndefined();
    expect(message.needsNewPage({ index: 0, text: "ordinary message", y: 190, height: 10 })).toBe(
      false,
    );
    expect(message.needsNewPage({ index: 1, text: "ordinary message", y: 191, height: 10 })).toBe(
      true,
    );
    expect(message.newLineX({ rtl: false })).toBe(0);
    const next = { x: 0, y: 99, startX: 0, startY: 99 };
    message.newPage(next);
    expect(next).toMatchObject({ y: 0, startY: 0 });
  });

for (const engine of ["MV", "MZ"] as const)
  test(`runtime shrinks picture dialogue to fit a page, then shares it evenly across pages in ${engine}`, async () => {
    // Three rows of 30 characters at 28px and 35 at 24px.
    const layout = { top: 1, indent: "  ", widest: ["x".repeat(30)], rows: 3 };
    const short = Array.from({ length: 21 }, () => "abcd").join(" ");
    const long = Array.from({ length: 10 }, () => "abcdefghi").join(" ");
    const { message } = await loadRuntime(engine, {
      $dataSystem: { rpgtlMessageLayouts: { [short]: layout, [long]: layout } },
    });
    message.contents.height = 144;
    expect(message.convertEscapeCharacters(short).split("\n")).toHaveLength(3);
    expect(message.contents.fontSize).toBe(24);
    // Four rows need two pages even at the smallest size. Two words a row still fit on two
    // pages, so the last page doesn't get one word alone.
    const pages = message.convertEscapeCharacters(long).split("\f");
    expect(message.contents.fontSize).toBe(24);
    expect(pages.map((page) => page.split("\n").filter(Boolean).length)).toEqual([3, 2]);
  });

test("runtime places MV picture dialogue by the rows the engine draws, not lineHeight()", async () => {
  // Like YEP_CoreEngine with a smaller font: MV still draws rows 36px apart, not 44px.
  const translated = Array.from({ length: 9 }, () => "abcdefghi").join(" ");
  const { message } = await loadRuntime("MV", {
    $dataSystem: {
      rpgtlMessageLayouts: {
        [translated]: {
          top: 1,
          indent: "        ",
          widest: ["x".repeat(30)],
          rows: 3,
        },
      },
    },
  });
  message.lineHeight = () => 44;
  message.contents.height = 144;
  const wrapped = message.convertEscapeCharacters(translated);
  expect(wrapped.split("\n")).toHaveLength(3);
  expect(message.contents.fontSize).toBe(28);
  expect((message as any)._rpgtlMessageLayout).toMatchObject({ top: 36, bottom: 144 });
});

test("runtime wraps picture dialogue to the frame's second widest line in the game's font", async () => {
  const translated = Array.from({ length: 3 }, () => "abcdefghi").join(" ");
  const { message } = await loadRuntime("MV", {
    $dataSystem: {
      rpgtlMessageLayouts: {
        // The 29 characters fit within the second widest line at 28px, but not the third.
        [translated]: {
          top: 1,
          indent: "  ",
          widest: ["x".repeat(20), "x".repeat(36), "x".repeat(29)],
          rows: 1,
        },
      },
    },
  });
  expect(message.convertEscapeCharacters(translated)).toBe(translated);
  expect(message.contents.fontSize).toBe(28);
});

test("runtime finds the layout of picture dialogue by its indented translation", async () => {
  const translated = `\n${" ".repeat(8)}Indented words`;
  const { message } = await loadRuntime("MV", {
    $dataSystem: {
      rpgtlMessageLayouts: {
        [translated]: { top: 1, indent: "        ", widest: ["x".repeat(30)], rows: 2 },
      },
    },
  });
  expect(message.convertEscapeCharacters(`${translated}\n`)).toBe("Indented words");
  expect((message as any)._rpgtlMessageLayout).toBeDefined();
});

test("runtime wraps text at the font size set by \\{, \\} and \\FS", async () => {
  for (const engine of ["MV", "MZ"] as const) {
    const { message } = await loadRuntime(engine);
    const [a, b, c] = ["a", "b", "c"].map((letter) => letter.repeat(15));
    // 31 characters take 310px at the normal size, and 443px after \{ in the 400px window.
    expect(message.convertEscapeCharacters(`${a} ${b}`)).toBe(`${a} ${b}`);
    expect(message.convertEscapeCharacters(`\\{${a} ${b}`)).toBe(`\x1b{${a}\n${b}`);
    expect(message.convertEscapeCharacters(`\\{${a}\\} ${b} ${c}`)).toBe(
      `\x1b{${a}\x1b} ${b}\n${c}`,
    );
    expect(message.convertEscapeCharacters(`\\FS[56]${a} ${b}`)).toBe(`\x1bFS[56]${a}\n${b}`);
    expect(message.contents.fontSize).toBe(28);
  }
});

test("runtime breaks Chinese text only where a line does not fit", async () => {
  const { message } = await loadRuntime("MV");
  const fits = "你".repeat(40);
  expect(message.convertEscapeCharacters(fits)).toBe(fits);
  expect(message.convertEscapeCharacters(fits + "好")).toBe(fits + "\n好");
});

test("runtime leaves text alone that the game wraps itself", async () => {
  const { message } = await loadRuntime("MV");
  const long = "word ".repeat(30).trim();
  expect(message.convertEscapeCharacters("<WordWrap>" + long)).toBe("<WordWrap>" + long);
  message._wordWrap = true;
  expect(message.convertEscapeCharacters(long)).toBe(long);
});

test("runtime wraps scrolling text to the window's width without a face indent", async () => {
  for (const engine of ["MV", "MZ"] as const) {
    const { scroll } = await loadRuntime(engine);
    expect(scroll.convertEscapeCharacters("a".repeat(30) + " b c " + "d".repeat(30))).toBe(
      "a".repeat(30) + " b c\n" + "d".repeat(30),
    );
  }
});

test("runtime wraps MZ plugin text drawn with a width, but not list rows", async () => {
  class Window_Base {
    contents = { width: 400, height: 72, fontSize: 28 };
    drawn: string[] = [];
    items = 1;
    textWidth(text: string) {
      return text.length * 10;
    }
    resetFontSettings() {}
    lineHeight() {
      return 36;
    }
    maxItems() {
      return this.items;
    }
    convertEscapeCharacters(text: string) {
      return text;
    }
    drawTextEx(text: string, _x: number, _y: number, _width?: number) {
      this.drawn.push(this.convertEscapeCharacters(text));
    }
  }
  await loadRuntime("MZ", { Window_Base });
  const win = new Window_Base();
  const detail = "I ran into the property manager in the hallway.";
  win.drawTextEx(detail, 10, 0, 200);
  // The text starts 10px in but is given the contents' whole 400px.
  const long = "a".repeat(20) + " " + "b".repeat(19);
  win.drawTextEx(long, 10, 0, 400);
  win.drawTextEx(detail, 10, 0);
  win.items = 3;
  win.drawTextEx(detail, 10, 0, 200);
  expect(win.drawn).toEqual([
    "I ran into the\nproperty manager in\nthe hallway.",
    "a".repeat(20) + "\n" + "b".repeat(19),
    detail,
    detail,
  ]);
  expect(win.convertEscapeCharacters(detail)).toBe(detail);
});

for (const engine of ["MV", "MZ"] as const)
  test(`runtime wraps help descriptions in ${engine}`, async () => {
    const { help } = await loadRuntime(engine);
    const description = "\\C[2]This description has many useful items inside this box.";
    expect(help.convertEscapeCharacters(description)).toBe(
      "\x1bC[2]This description has many useful items\ninside this box.",
    );
  });

test("runtime wraps MV help text to a window that a plugin narrowed after making its contents", async () => {
  const { help } = await loadRuntime("MV");
  Object.assign(help, { contentsWidth: () => 250, contentsHeight: () => 72 });
  const wrapped = help.convertEscapeCharacters("Slightly raises the magic defense of an ally.");
  expect(wrapped.split("\n").every((line) => help.textWidth(line) <= 240)).toBe(true);
});

test("runtime wraps help text where a window moved past the screen's right edge has its frame", async () => {
  const { help } = await loadRuntime("MV", { Graphics: { width: 480 } });
  // The frame ends 80px before the screen's edge, 284px into the contents.
  Object.assign(help, { x: 80, width: 436, padding: 18 });
  // 380px wide: it fits the 400px contents but not the frame.
  const wrapped = help
    .convertEscapeCharacters("Use high-grade armor to synthesize it.")
    .split("\n");
  expect(wrapped).toEqual(["Use high-grade armor to", "synthesize it."]);
});

test("runtime shrinks help text that is too tall for the window until it fits", async () => {
  const { help } = await loadRuntime("MV");
  const description = "word ".repeat(30).trim();
  const wrapped = help.convertEscapeCharacters(description).split("\n");
  // At 16px the text needs three lines, and three 24px lines fit the 72px window.
  expect(wrapped).toHaveLength(3);
  expect(wrapped.join(" ")).toBe(description);
  expect(help.contents.fontSize).toBe(16);
  help.resetFontSettings();
  expect(help.contents.fontSize).toBe(16);

  help.convertEscapeCharacters("Short.");
  help.resetFontSettings();
  expect(help.contents.fontSize).toBe(28);
});

for (const engine of ["MV", "MZ"] as const)
  test(`runtime keeps a message's blank rows, size and colour on each page it adds in ${engine}`, async () => {
    const { message } = await loadRuntime(engine);
    // After the blank row, two rows of the bigger font fit.
    const text = "\n\\{\\C[2]" + Array.from({ length: 9 }, () => "abcde").join(" ");
    expect(message.convertEscapeCharacters(text)).toBe(
      "\n\x1b{\x1bC[2]abcde abcde abcde\nabcde abcde abcde\f\n\n\x1b{\x1bC[2]abcde abcde abcde",
    );
  });
