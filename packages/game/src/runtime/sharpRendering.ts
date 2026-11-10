import { type Filter, type Renderer, type TextBitmap, rm } from "./engine.ts";

// An enlarged game is copied at the largest whole multiple of its size, each pixel exactly, and
// the browser smooths only the rest of the way: pixels stay even without blurring the picture.
export function hookSharpPixels() {
  const { SceneManager } = rm;
  const initGraphics = SceneManager?.initGraphics;
  if (!rm.rpgtlSharpPixels || !SceneManager || !initGraphics) return;
  SceneManager.initGraphics = function (this: unknown, ...args: unknown[]) {
    const result = initGraphics.apply(this, args);
    const renderer = rm.Graphics?._app?.renderer ?? rm.Graphics?._renderer;
    if (renderer) sharpenRenderer(renderer);
    return result;
  };
}

function sharpenRenderer(renderer: Renderer) {
  const view = renderer.view;
  const copy = view.ownerDocument.createElement("canvas");
  const context = copy.getContext("2d");
  if (!context) return;
  let layout = "";
  let factor = 1;
  const render = renderer.render;
  renderer.render = function (this: Renderer, ...args: unknown[]) {
    const result = render.apply(this, args);
    // A second argument renders into a texture, such as a snapshot for the menu background.
    if (args[1] != null) return result;
    const scale = (parseFloat(view.style.width) / view.width) * (rm.devicePixelRatio || 1);
    const next = `${view.width}x${view.height} ${scale} ${view.style.cssText}`;
    if (next !== layout) {
      factor = Math.floor(scale + 1e-6);
      if (factor < 2) {
        copy.remove();
        view.style.visibility = "";
      } else {
        copy.width = view.width * factor;
        copy.height = view.height * factor;
        copy.style.cssText = view.style.cssText;
        copy.style.visibility = "visible";
        copy.style.pointerEvents = "none";
        context.imageSmoothingEnabled = false;
        if (!copy.isConnected) view.after(copy);
        view.style.visibility = "hidden";
      }
      // Not `next`: setting the visibility above changed cssText.
      layout = `${view.width}x${view.height} ${scale} ${view.style.cssText}`;
    }
    if (factor >= 2) context.drawImage(view, 0, 0, copy.width, copy.height);
    return result;
  };
}

// The game renders at the screen's resolution, rounded to a whole multiple of its size: up so text
// stays sharp when the browser shrinks the picture the rest of the way, or down with sharp pixels
// so pixels stay even. Bitmaps made for text are redrawn at that resolution.
export function renderScale() {
  const display = (rm.Graphics?._realScale ?? 1) * (rm.devicePixelRatio || 1);
  const scale = rm.rpgtlSharpPixels ? Math.floor(display + 1e-3) : Math.ceil(display - 1e-3);
  return Math.min(4, Math.max(1, scale));
}

// A texture longer than the GPU takes, or a canvas longer than the browser makes, draws black.
// Plugins size a scrolling window's contents up to that limit, such as CGMZ's 20 windows tall.
const longestSide = () => {
  const gl = (rm.Graphics?._app?.renderer ?? rm.Graphics?._renderer)?.gl;
  const most: unknown = gl?.getParameter(gl.MAX_TEXTURE_SIZE);
  return Math.min(typeof most === "number" ? most : 16384, 16384);
};

/** The render scale, or the largest whole one at which the bitmap stays within that limit. */
const fittingScale = (bitmap: TextBitmap) => {
  const side = Math.max(
    bitmap._rpgtlWidth ?? bitmap.canvas.width,
    bitmap._rpgtlHeight ?? bitmap.canvas.height,
  );
  return Math.max(1, Math.min(renderScale(), Math.floor(longestSide() / Math.max(1, side))));
};

// Loaded images keep their own pixels; only bitmaps the game made itself are redrawn.
const sharpen = (bitmap: TextBitmap) => {
  if (bitmap._image || bitmap._url) return;
  const scale = fittingScale(bitmap);
  if (scale !== (bitmap._rpgtlScale ?? 1)) rescale(bitmap, scale);
};

export function hookSharpText() {
  const { Graphics, Bitmap } = rm;
  const update = Graphics?._updateAllElements;
  if (!rm.rpgtlSharpText || !Graphics || !update || !Bitmap) return;
  Graphics._updateAllElements = function (this: unknown, ...args: unknown[]) {
    const result = update.apply(this, args);
    const renderer = Graphics._app?.renderer ?? Graphics._renderer;
    if (!renderer || !Graphics._width || !Graphics._height) return result;
    const scale = renderScale();
    renderer.resolution = scale;
    const target = renderer.rootRenderTarget;
    if (target && target.resolution !== scale) {
      target.resolution = scale;
      // PIXI 4 skips resizing to the size it already has.
      target.size.width = 0;
    }
    if (renderer.rootResolution !== undefined) renderer.rootResolution = scale;
    renderer.resize(Graphics._width, Graphics._height);
    sharpenFilters(renderer);
    return result;
  };

  const prototype = Bitmap.prototype as unknown as TextBitmap;
  for (const key of ["width", "height"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    const get = descriptor?.get;
    if (!descriptor || !get) continue;
    Object.defineProperty(prototype, key, {
      ...descriptor,
      get(this: TextBitmap) {
        if (!this._rpgtlScale) return get.call(this);
        return key === "width" ? this._rpgtlWidth : this._rpgtlHeight;
      },
    });
  }

  const drawText = prototype.drawText;
  prototype.drawText = function (this: TextBitmap, ...args: unknown[]) {
    sharpen(this);
    return drawText.apply(this, args);
  };

  const resize = prototype.resize;
  prototype.resize = function (this: TextBitmap, width: number, height: number) {
    const scaled = !!this._rpgtlScale;
    delete this._rpgtlScale;
    delete this._rpgtlWidth;
    delete this._rpgtlHeight;
    resize.call(this, width, height);
    if (scaled) rescale(this, fittingScale(this));
  };

  const blt = prototype.blt;
  prototype.blt = function (this: TextBitmap, source: TextBitmap, ...args: number[]) {
    const scale = source._rpgtlScale;
    if (!scale) return blt.call(this, source, ...args);
    // Text copied from a sharp bitmap stays sharp.
    sharpen(this);
    const [sx = 0, sy = 0, sw = 0, sh = 0, dx = 0, dy = 0] = args;
    const dw = args[6] || sw;
    const dh = args[7] || sh;
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
    const context = this.context;
    context.globalCompositeOperation = "source-over";
    context.drawImage(
      source.canvas,
      sx * scale,
      sy * scale,
      sw * scale,
      sh * scale,
      dx,
      dy,
      dw,
      dh,
    );
    changed(this);
  };

  for (const key of ["getPixel", "getAlphaPixel"] as const) {
    const read = prototype[key];
    prototype[key] = function (this: TextBitmap, x: number, y: number) {
      const scale = this._rpgtlScale ?? 1;
      return read.call(this, Math.floor(x * scale), Math.floor(y * scale));
    };
  }
}

// Filters default to resolution 1, and MV draws every window through one, which would bring
// its text back down to the game's size.
function sharpenFilters(renderer: Renderer) {
  if (renderer._rpgtlSharpFilters) return;
  renderer._rpgtlSharpFilters = true;
  const manager = renderer.filterManager;
  if (manager) {
    const pushFilter = manager.pushFilter;
    manager.pushFilter = function (this: unknown, target, filters) {
      filterResolution(filters, renderer.resolution);
      return pushFilter.call(this, target, filters);
    };
  }
  const system = renderer.filter;
  if (system) {
    const push = system.push;
    system.push = function (this: unknown, target, filters) {
      filterResolution(filters, renderer.resolution);
      return push.call(this, target, filters);
    };
  }
}

// A filter list renders at one resolution. Blurs stay at the game's: what they draw is blurred
// anyway, and they pad their texture past the screen by twice their strength, so a battle
// transition's blur of several hundred pixels would need textures larger than the GPU can draw.
function filterResolution(filters: Filter[], resolution: number) {
  const blurred = filters.some((filter) => "blurXFilter" in filter || "passes" in filter);
  for (const filter of filters) filter.resolution = blurred ? 1 : resolution;
}

function changed(bitmap: TextBitmap) {
  if (bitmap._setDirty) bitmap._setDirty();
  else bitmap._baseTexture.update();
}

// What a canvas resize resets, apart from the transform and smoothing, which rescale sets itself.
const drawingState = [
  "globalAlpha",
  "globalCompositeOperation",
  "fillStyle",
  "strokeStyle",
  "lineWidth",
  "lineCap",
  "lineJoin",
  "miterLimit",
  "lineDashOffset",
  "font",
  "textAlign",
  "textBaseline",
  "direction",
  "letterSpacing",
  "wordSpacing",
  "fontKerning",
  "fontStretch",
  "fontVariantCaps",
  "textRendering",
  "filter",
  "imageSmoothingQuality",
  "shadowColor",
] as const;
// Shadows are measured in canvas pixels, not through the transform, so they grow with the canvas.
const shadowSizes = ["shadowBlur", "shadowOffsetX", "shadowOffsetY"] as const;

// Reads the context's drawing state and returns a function that puts it back after a resize to
// `growth` times the canvas's size.
function saveDrawingState(context: CanvasRenderingContext2D, growth: number) {
  const fields = context as unknown as Record<string, unknown>;
  const saved = drawingState.map((key) => [key, fields[key]] as const);
  const shadows = shadowSizes.map((key) => [key, context[key]] as const);
  const dash = context.getLineDash();
  return () => {
    for (const [key, value] of saved) if (value !== undefined) fields[key] = value;
    for (const [key, value] of shadows) context[key] = value * growth;
    context.setLineDash(dash);
  };
}

// Redraws what the bitmap holds at `scale` times its size in game pixels. Drawing keeps using game
// pixels through the context's transform, and the texture reports the same size to sprites.
export function rescale(bitmap: TextBitmap, scale: number) {
  const canvas = bitmap.canvas;
  const width = bitmap._rpgtlWidth ?? canvas.width;
  const height = bitmap._rpgtlHeight ?? canvas.height;
  const before = canvas.ownerDocument.createElement("canvas");
  before.width = canvas.width;
  before.height = canvas.height;
  // An empty canvas, such as MZ's name box with no name, can't be drawn from.
  const empty = !canvas.width || !canvas.height;
  if (!empty) before.getContext("2d")?.drawImage(canvas, 0, 0);
  // Resizing the canvas resets its context, but games and plugins set some of it only once or only
  // when it changes, as MV and MZ do with paint opacity.
  const state = saveDrawingState(bitmap.context, scale / (bitmap._rpgtlScale ?? 1));
  // Rounded up, so the texture is never smaller than the frames sprites cut from it.
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  if (scale === 1) {
    delete bitmap._rpgtlScale;
    delete bitmap._rpgtlWidth;
    delete bitmap._rpgtlHeight;
  } else {
    bitmap._rpgtlScale = scale;
    bitmap._rpgtlWidth = width;
    bitmap._rpgtlHeight = height;
  }
  const context = bitmap.context;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  // Icons and faces copied in follow the bitmap's own smoothing, as its texture does.
  context.imageSmoothingEnabled = !!bitmap._smooth;
  if (!empty) context.drawImage(before, 0, 0, width, height);
  state();
  const texture = bitmap._baseTexture;
  if (texture.setRealSize) texture.setRealSize(canvas.width, canvas.height, scale);
  else {
    texture.resolution = scale;
    texture.realWidth = canvas.width;
    texture.realHeight = canvas.height;
    texture.width = canvas.width / scale;
    texture.height = canvas.height / scale;
  }
  changed(bitmap);
}
