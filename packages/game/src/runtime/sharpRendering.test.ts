import { test, expect } from "vite-plus/test";
import { loadRuntime } from "../testUtils/fixture.ts";

test("Sharp pixels copy an enlarged game at a whole multiple of its size", async () => {
  const drawn: number[][] = [];
  const copy = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    isConnected: false,
    getContext: () => ({
      imageSmoothingEnabled: true,
      drawImage: (_: unknown, x: number, y: number, width: number, height: number) =>
        drawn.push([x, y, width, height]),
    }),
    remove() {
      copy.isConnected = false;
    },
  };
  const view = {
    width: 816,
    height: 624,
    style: { width: "1882px", cssText: "position: absolute;" } as Record<string, string>,
    ownerDocument: { createElement: () => copy },
    after: () => (copy.isConnected = true),
  };
  const rendered: unknown[][] = [];
  const renderer = { view, render: (...args: unknown[]) => void rendered.push(args) };
  await loadRuntime("MZ", {
    rpgtlSharpPixels: true,
    devicePixelRatio: 1,
    Graphics: { _app: { renderer } },
    SceneManager: {
      run(this: { initGraphics(): void }) {
        this.initGraphics();
      },
      initGraphics() {},
    },
  });

  // 1882px is 2.31 times 816: twice the size with even pixels, smoothed the rest of the way.
  renderer.render("stage");
  expect(rendered).toEqual([["stage"]]);
  expect([copy.width, copy.height, copy.isConnected]).toEqual([1632, 1248, true]);
  expect(copy.style).toMatchObject({ cssText: "position: absolute;", pointerEvents: "none" });
  expect(view.style.visibility).toBe("hidden");
  expect(drawn).toEqual([[0, 0, 1632, 1248]]);

  // Rendering into a texture, such as a snapshot, leaves the copy alone.
  renderer.render("stage", "texture");
  expect(drawn).toHaveLength(1);

  // Below twice the size, the game shows itself as before.
  view.style.width = "1224px";
  renderer.render("stage");
  expect(drawn).toHaveLength(1);
  expect(copy.isConnected).toBe(false);
  expect(view.style.visibility).toBe("");
});

// The drawing state a new or resized canvas starts with.
const fresh = () => ({
  globalAlpha: 1,
  font: "10px sans-serif",
  fillStyle: "#000000",
  shadowBlur: 0,
  shadowOffsetX: 0,
  dash: [] as number[],
});

test("Sharp text renders the game and the bitmaps it draws text into at the screen's resolution", async () => {
  const calls: unknown[][] = [];
  // A canvas whose context records what is drawn into it.
  const canvas = (width: number, height: number): any => {
    const element: any = {
      // Like a real canvas, resizing resets the context's state.
      get width() {
        return width;
      },
      set width(value: number) {
        width = value;
        Object.assign(element.context, fresh());
      },
      height,
      ownerDocument: { createElement: () => canvas(0, 0) },
      getContext: () => element.context,
    };
    element.context = {
      ...fresh(),
      getLineDash: () => element.context.dash,
      setLineDash: (dash: number[]) => (element.context.dash = dash),
      setTransform: (...args: unknown[]) => calls.push(["setTransform", ...args]),
      drawImage: (source: any, ...args: unknown[]) => {
        if (!source.width || !source.height) throw new Error("drawImage from an empty canvas");
        calls.push(["drawImage", source === element ? "self" : source.width, ...args]);
      },
      getImageData: (x: number, y: number) => {
        calls.push(["getImageData", x, y]);
        return { data: [0, 0, 0, 255] };
      },
    };
    return element;
  };
  class Bitmap {
    _url = "";
    _image: unknown = null;
    _smooth = false;
    canvas: any;
    _baseTexture: any;
    drawn: unknown[] = [];
    constructor(width: number, height: number) {
      this.canvas = canvas(width, height);
      this._baseTexture = { resolution: 1, width, height, update() {} };
    }
    get context() {
      return this.canvas.context;
    }
    get width() {
      return this.canvas.width;
    }
    get height() {
      return this.canvas.height;
    }
    _setDirty() {}
    resize(width: number, height: number) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    drawText(text: string) {
      this.drawn.push(text);
    }
    blt(..._args: unknown[]) {
      calls.push(["original blt"]);
    }
    getAlphaPixel(x: number, y: number) {
      return this.context.getImageData(x, y).data[3];
    }
    getPixel(x: number, y: number) {
      return this.context.getImageData(x, y).data[0];
    }
  }
  const resized: unknown[] = [];
  const renderer = {
    resolution: 1,
    rootRenderTarget: { resolution: 1, size: { width: 816 } },
    filterManager: {
      pushFilter: (_: unknown, filters: { resolution: number }[]) => resized.push(filters),
    },
    resize(width: number, height: number) {
      resized.push([width, height, this.resolution]);
    },
  };
  const Graphics = {
    _width: 816,
    _height: 624,
    _realScale: 2.31,
    _renderer: renderer,
    _updateAllElements() {},
  };
  await loadRuntime("MV", { rpgtlSharpText: true, devicePixelRatio: 1, Graphics, Bitmap });

  // 2.31 times the game's size renders at 3 times, which the browser shrinks the rest of the way.
  Graphics._updateAllElements();
  expect(resized).toEqual([[816, 624, 3]]);
  expect(renderer.rootRenderTarget).toEqual({ resolution: 3, size: { width: 0 } });
  const filter = { resolution: 1 };
  renderer.filterManager.pushFilter(null, [filter]);
  expect(filter.resolution).toBe(3);
  // A list with a blur stays at the game's resolution.
  const blur = { resolution: 1, blurXFilter: {}, blurYFilter: {} };
  renderer.filterManager.pushFilter(null, [filter, blur]);
  expect([filter.resolution, blur.resolution]).toEqual([1, 1]);

  const contents: any = new Bitmap(400, 101);
  expect([contents.width, contents.canvas.width]).toEqual([400, 400]);
  // Drawing state the game set before, like a disabled row's faded paint opacity, survives the
  // redraw at the new size, with shadows grown along with the canvas.
  Object.assign(contents.context, {
    globalAlpha: 160 / 255,
    font: "22px GameFont",
    fillStyle: "#a060ff",
    shadowBlur: 2,
    shadowOffsetX: 1,
    dash: [4, 2],
  });
  contents.drawText("Hello");
  expect(contents.context).toMatchObject({
    globalAlpha: 160 / 255,
    font: "22px GameFont",
    fillStyle: "#a060ff",
    shadowBlur: 6,
    shadowOffsetX: 3,
    dash: [4, 2],
  });
  expect(contents.drawn).toEqual(["Hello"]);
  expect([contents.width, contents.height, contents.canvas.width, contents.canvas.height]).toEqual([
    400, 101, 1200, 303,
  ]);
  expect(contents._baseTexture).toMatchObject({ resolution: 3, width: 400, height: 101 });
  expect(calls).toContainEqual(["setTransform", 3, 0, 0, 3, 0, 0]);
  // What the bitmap held before is drawn again at the new size.
  expect(calls).toContainEqual(["drawImage", 400, 0, 0, 400, 101]);

  calls.length = 0;
  contents.getAlphaPixel(10, 20);
  expect(calls).toEqual([["getImageData", 30, 60]]);

  // Copying from a sharp bitmap reads its pixels at their own scale and sharpens the target.
  calls.length = 0;
  const copy: any = new Bitmap(200, 50);
  copy.blt(contents, 10, 0, 100, 40, 0, 5);
  expect(calls).not.toContainEqual(["original blt"]);
  expect(calls).toContainEqual(["drawImage", 1200, 30, 0, 300, 120, 0, 5, 100, 40]);
  expect(copy.canvas.width).toBe(600);

  // Resizing keeps the bitmap sharp at its new size.
  contents.resize(300, 60);
  expect([contents.width, contents.height, contents.canvas.width]).toEqual([300, 60, 900]);

  // An empty bitmap, like MZ's name box for a line with no name, takes text without copying itself.
  const nameBox: any = new Bitmap(0, 36);
  nameBox.drawText("");
  expect([nameBox.width, nameBox.canvas.width, nameBox.drawn]).toEqual([0, 0, [""]]);

  // Loaded images keep their own pixels.
  const image: any = new Bitmap(48, 48);
  image._url = "img/faces/Actor1.png";
  image.drawText("Name");
  expect([image.width, image.canvas.width]).toEqual([48, 48]);

  // A scrolling window's tall contents stay within the largest texture the GPU takes, past which
  // they would draw black: at the largest whole scale that fits, or at the game's own.
  Object.assign(renderer, { gl: { MAX_TEXTURE_SIZE: 3379, getParameter: () => 8192 } });
  const tall: any = new Bitmap(400, 3000);
  tall.drawText("Quest");
  expect([tall.height, tall.canvas.height]).toEqual([3000, 6000]);
  const tallest: any = new Bitmap(400, 8192);
  tallest.drawText("Quest");
  expect([tallest.height, tallest.canvas.height]).toEqual([8192, 8192]);
});
