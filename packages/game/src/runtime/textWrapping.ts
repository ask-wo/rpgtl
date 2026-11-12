import { type TextWindow, rm } from "./engine.ts";

// A converted escape code: the escape character, then a symbol or letters with an optional number.
const escape = String.fromCharCode(27);
const token = new RegExp(`${escape}(?:[$.|^!><{}\\\\]|[A-Za-z]+(?:\\[\\d+\\])?)|[^]`, "gu");
const cjk = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;

// Breaks lines at spaces, and between Chinese and Japanese characters, to fit `max` pixels.
// Text after \{, \} or MZ's \FS[n] is measured at the size the engine will draw it in.
function wrapText(win: TextWindow, text: string, start: number, max: number) {
  const iconWidth = (rm.ImageManager?.iconWidth ?? 32) + 4;
  const fontSize = win.contents.fontSize;
  const wrapped = text
    .split("\n")
    .map((line) => {
      const lines: string[] = [];
      let current = "";
      let width = 0;
      let space = "";
      let spaceWidth = 0;
      let unit = "";
      let unitWidth = 0;
      let plain = "";
      const measure = () => {
        if (plain) unitWidth += win.textWidth(plain);
        plain = "";
      };
      const flush = () => {
        if (!unit) return;
        measure();
        if (current && start + width + spaceWidth + unitWidth > max) {
          lines.push(current);
          current = "";
          width = 0;
        } else if (current) {
          current += space;
          width += spaceWidth;
        }
        current += unit;
        width += unitWidth;
        space = unit = "";
        spaceWidth = unitWidth = 0;
      };
      for (const [piece] of line.matchAll(token)) {
        if (piece === " ") {
          flush();
          space += piece;
          spaceWidth += win.textWidth(piece);
        } else if (piece[0] === escape) {
          unit += piece;
          const code = piece.slice(1).toUpperCase();
          if (code.startsWith("I[")) unitWidth += iconWidth;
          else if (code === "{" || code === "}" || code.startsWith("FS[")) {
            measure();
            if (code === "{") win.makeFontBigger?.();
            else if (code === "}") win.makeFontSmaller?.();
            else win.contents.fontSize = Number(code.slice(3, -1));
          }
        } else {
          unit += piece;
          plain += piece;
          if (cjk.test(piece)) flush();
        }
      }
      flush();
      lines.push(current);
      return lines.join("\n");
    })
    .join("\n");
  win.contents.fontSize = fontSize;
  return wrapped;
}

const fontCode = new RegExp(`${escape}(?:[{}]|FS\\[\\d+\\])`, "gi");
// The height the engine draws these lines in. Each line takes its largest font plus a gap: 8
// pixels in MV, whatever lineHeight() leaves above the game's font in MZ. So in MV, rows
// are not lineHeight() apart when a plugin changes the font size or line height.
function lineHeights(win: TextWindow, text: string) {
  const fontSize = win.contents.fontSize;
  const heights = text.split("\n").map((line) => {
    const height = win.calcTextHeight({ text: line, index: 0 }, false);
    for (const [code] of line.matchAll(fontCode)) {
      if (code === `${escape}{`) win.makeFontBigger?.();
      else if (code === `${escape}}`) win.makeFontSmaller?.();
      else win.contents.fontSize = Number(code.slice(4, -1));
    }
    return height;
  });
  win.contents.fontSize = fontSize;
  return heights;
}
const textHeight = (win: TextWindow, text: string) =>
  lineHeights(win, text).reduce((sum, height) => sum + height, 0);

// How many pages of `area` pixels the engine fills with lines of these heights.
function pageCount(heights: number[], area: number) {
  let pages = 1;
  let used = 0;
  for (const height of heights) {
    if (used && used + height > area) {
      pages++;
      used = 0;
    }
    used += height;
  }
  return pages;
}

// A new page resets the font size and the text colour.
const pageStateCode = new RegExp(`${escape}(?:[{}]|FS\\[\\d+\\]|C\\[\\d+\\])`, "gi");
function pageStateCodes(text: string) {
  let font = "";
  let color = "";
  for (const [code] of text.matchAll(pageStateCode)) {
    const name = code.slice(1).toUpperCase();
    if (name.startsWith("C[")) color = code;
    else if (name.startsWith("FS[")) font = code;
    else font += code;
  }
  return font + color;
}

// Text on more than one page keeps the number of lines it has at full width, narrowed only as far
// as that allows, and shares them evenly, so that no page holds only a word or two. Narrowing to
// fill the pages' rows would squeeze a line of overflow into half-width lines. Both engines skip
// one line break after a form feed, so each page after the first starts with one.
function messagePages(
  win: TextWindow,
  text: string,
  start: number,
  max: number,
  area: number,
  leading = "",
) {
  let lines = wrapText(win, text, start, max);
  const count = (wrapped: string) => pageCount(lineHeights(win, wrapped), area);
  const pages = count(lines);
  if (pages === 1) return leading + lines;
  const lineCount = lines.split("\n").length;
  let low = start + 1;
  let high = max;
  while (low < high) {
    const right = Math.floor((low + high) / 2);
    if (wrapText(win, text, start, right).split("\n").length === lineCount) high = right;
    else low = right + 1;
  }
  lines = wrapText(win, text, start, high);
  const heights = lineHeights(win, lines);
  const perPage = Math.ceil(heights.length / pages);
  const split: string[][] = [[]];
  let used = 0;
  for (const [index, line] of lines.split("\n").entries()) {
    const height = heights[index] ?? 0;
    if (used && (used + height > area || split.at(-1)?.length === perPage)) {
      split.push([]);
      used = 0;
    }
    used += height;
    split.at(-1)?.push(line);
  }
  let before = "";
  return split
    .map((page) => {
      const rows = page.join("\n");
      const shown = before ? `\n${leading}${pageStateCodes(before)}${rows}` : leading + rows;
      before += rows;
      return shown;
    })
    .join("\f");
}

const smallestHelpFont = 14;
// How much smaller than the game's font a message fitted to its original text area may get.
const messageFontShrink = 4;

// The help window has a fixed height, so text that still needs too many lines after
// wrapping gets a smaller font until it fits.
function fitHelpText(win: TextWindow, text: string, start: number, max: number) {
  win._rpgtlFontSize = undefined;
  win.resetFontSettings();
  const base = win.contents.fontSize;
  const visibleHeight = Math.min(win.contents.height, win.contentsHeight?.() ?? Infinity);
  for (let size = base; ; size -= 2) {
    win.contents.fontSize = size;
    const wrapped = wrapText(win, text, start, max);
    if (textHeight(win, wrapped) <= visibleHeight || size - 2 < smallestHelpFont) {
      win._rpgtlFontSize = size < base ? size : undefined;
      return wrapped;
    }
  }
}

// Both engines convert a message's escape codes in one call before drawing it, so the
// hook there sees the whole message. Added line breaks make the engine start new pages.
export function hookWrapping() {
  for (const Window of [rm.Window_Message, rm.Window_ScrollText, rm.Window_Help]) {
    const proto = Window?.prototype;
    if (!proto) continue;
    const convert = proto.convertEscapeCharacters;
    proto.convertEscapeCharacters = function (this: TextWindow, text: string) {
      const converted = convert.call(this, text);
      // A message's text state has its text only after the conversion that starts it. Plugins
      // may convert other text on the window while a message shows, such as to measure it.
      if (Window === rm.Window_Message && this._textState?.text === undefined) {
        this._rpgtlMessageLayout = undefined;
        this._rpgtlFontSize = undefined;
      }
      if (/<WordWrap>/i.test(text) || this._wordWrap) return converted;
      const isHelp = Window === rm.Window_Help;
      if (isHelp) {
        const rect = this.baseTextRect?.();
        const start = rect?.x ?? this.textPadding?.() ?? 0;
        // Plugins such as MOG_BattleHud resize MV's help window after it made its contents,
        // which then reach past the window.
        let max = rect
          ? rect.x + rect.width
          : Math.min(this.contents.width, this.contentsWidth?.() ?? Infinity);
        // MOG_SceneItem moves the full-width help window right, past the screen's edge, and
        // its frame picture ends as far from the right edge as the window starts from the left.
        const screen = rm.Graphics?.width;
        const { x = 0, width = 0, padding = 0 } = this;
        if (screen && x > 0 && x + width > screen)
          max = Math.min(max, screen - 2 * x - 2 * padding);
        return fitHelpText(this, converted, start, max);
      }
      this.resetFontSettings();
      const source =
        Window === rm.Window_Message && rm.$dataSystem?.rpgtlMessageLayouts?.[text.trimEnd()];
      if (source) {
        const base = this.contents.fontSize;
        const row = textHeight(this, "");
        const start = (this.newLineX?.({ rtl: false }) ?? 0) + this.textWidth(source.indent);
        // The second widest line, as a single line may already run past the frame.
        const widths = source.widest.map((line) => this.textWidth(line)).toSorted((a, b) => b - a);
        const max = Math.min(this.contents.width, start + (widths[1] ?? widths[0]!));
        const top = source.top * row;
        // A frame whose text reached the last row the window shows may use the space below it.
        const bottom =
          source.top + source.rows >= Math.floor(this.contents.height / row)
            ? this.contents.height
            : Math.min(this.contents.height, top + source.rows * row);
        // Text that doesn't fit at the smallest size continues on more pages of the area.
        const smallest = base - messageFontShrink;
        let size = base;
        for (; ; size -= 2) {
          this.contents.fontSize = size;
          const lines = wrapText(this, converted.trim(), start, max);
          if (pageCount(lineHeights(this, lines), bottom - top) === 1 || size - 2 < smallest) break;
        }
        this._rpgtlFontSize = size;
        this._rpgtlMessageLayout = { start, top, bottom };
        return messagePages(this, converted.trim(), start, max, bottom - top);
      }
      if (Window === rm.Window_Message) {
        // Games often start a message with blank rows to place it lower in the window, so
        // every page keeps them.
        const leading = /^\n*/.exec(converted)?.[0] ?? "";
        const area = this.contents.height - leading.length * textHeight(this, "");
        const start = this.newLineX?.({ rtl: false }) ?? 0;
        return messagePages(
          this,
          converted.slice(leading.length),
          start,
          this.contentsWidth?.() ?? this.contents.width,
          area,
          leading,
        );
      }
      // MZ scrolling text measures its text before it makes contents of the window's size.
      const width = this.contentsWidth?.() ?? this.contents.width;
      return wrapText(this, converted, this.newLineX?.({ rtl: false }) ?? 0, width);
    };
  }
  // Other MZ windows, such as a plugin's quest details, draw text with drawTextEx and a width.
  // Lines that would run past it are wrapped, except in lists, where a second line would cover
  // the next row.
  const base = rm.Window_Base?.prototype;
  if (base?.drawTextEx && base.convertEscapeCharacters) {
    const { drawTextEx, convertEscapeCharacters } = base;
    base.convertEscapeCharacters = function (this: TextWindow, text: string) {
      const converted = convertEscapeCharacters.call(this, text);
      const wrap = this._rpgtlWrap;
      return wrap ? wrapText(this, converted, wrap.start, wrap.max) : converted;
    };
    const ownWrapping = [rm.Window_Message, rm.Window_ScrollText, rm.Window_Help];
    base.drawTextEx = function (this: TextWindow, text, x, y, width, ...rest) {
      const wraps =
        typeof width === "number" &&
        width > 0 &&
        !(this.maxItems && this.maxItems() > 1) &&
        !this._wordWrap &&
        !/<WordWrap>/i.test(String(text)) &&
        !ownWrapping.some((Window) => Window && this instanceof (Window as any));
      // Plugins often start the text inside the window and still pass its whole width.
      this._rpgtlWrap = wraps
        ? { start: x, max: Math.min(x + width, this.contents.width) }
        : undefined;
      try {
        return drawTextEx.call(this, text, x, y, width, ...rest);
      } finally {
        this._rpgtlWrap = undefined;
      }
    };
  }
  // MV resets the font after converting the text, so the smaller size is applied here.
  for (const proto of [rm.Window_Help?.prototype, rm.Window_Message?.prototype]) {
    if (!proto) continue;
    const reset = proto.resetFontSettings;
    proto.resetFontSettings = function (this: TextWindow) {
      reset.call(this);
      if (this._rpgtlFontSize) this.contents.fontSize = this._rpgtlFontSize;
    };
  }
  const message = rm.Window_Message?.prototype;
  if (message) {
    const { newLineX, newPage, needsNewPage } = message;
    message.newLineX = function (state) {
      return this._rpgtlMessageLayout?.start ?? newLineX?.call(this, state) ?? 0;
    };
    if (newPage)
      message.newPage = function (state) {
        newPage.call(this, state);
        if (this._rpgtlMessageLayout) {
          state.x = this._rpgtlMessageLayout.start;
          state.y = this._rpgtlMessageLayout.top;
          if (state.startX !== undefined) state.startX = state.x;
          if (state.startY !== undefined) state.startY = state.y;
        }
      };
    if (needsNewPage)
      message.needsNewPage = function (state) {
        const layout = this._rpgtlMessageLayout;
        return (
          needsNewPage.call(this, state) ||
          !!(layout && state.index < state.text.length && state.y + state.height > layout.bottom)
        );
      };
  }
}
