import { standingFrame } from "./model.ts";
import type { CharacterBitmap, CharacterSprite, MapGame } from "./model.ts";

/**
 * The game's character sheets as the map view draws them. `loaded` hears the name of each sheet
 * that finishes loading.
 */
export function makeSprites(game: MapGame, loaded: (characterName: string) => void) {
  const sheets = new Map<string, CharacterBitmap>();
  const frames = new Map<string, { plain: HTMLCanvasElement; faded?: HTMLCanvasElement }>();
  const alphaMasks = new Map<string, Uint8ClampedArray | null>();

  function load(image: CharacterSprite) {
    if (!game.ImageManager) return undefined;
    let bitmap = sheets.get(image.characterName);
    if (!bitmap) {
      bitmap = game.ImageManager.loadCharacter(image.characterName);
      sheets.set(image.characterName, bitmap);
      const name = image.characterName;
      bitmap.addLoadListener(() => queueMicrotask(() => loaded(name)));
    }
    if (!bitmap.isReady()) return undefined;
    const rect = standingFrame(
      image.characterName,
      bitmap.width,
      bitmap.height,
      image.characterIndex,
      image.direction,
      image.pattern,
    );
    if (rect.width < 1 || rect.height < 1) return undefined;
    // MZ games can set their own tile size; characters are drawn at the game's scale.
    const tileSize = game.$dataSystem?.tileSize || 48;
    return {
      name: image.characterName,
      source: bitmap._image ?? bitmap.canvas,
      rect,
      tilesWide: rect.width / tileSize,
      tilesHigh: rect.height / tileSize,
    };
  }

  // The frame copied out of its sheet, for the faded copy and the hit test.
  function frameOf({ name, source, rect }: LoadedSprite) {
    const key = `${name}:${rect.x},${rect.y}`;
    let copy = frames.get(key);
    if (!copy) {
      const plain = Object.assign(document.createElement("canvas"), {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
      plain
        .getContext("2d")!
        .drawImage(
          source,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          0,
          0,
          plain.width,
          plain.height,
        );
      frames.set(key, (copy = { plain }));
    }
    return { key, copy };
  }

  // Events without commands are drawn faded and gray. A canvas filter is slow, so it runs once
  // per frame of a sheet instead of on every redraw.
  function faded(sprite: LoadedSprite) {
    const { copy } = frameOf(sprite);
    if (!copy.faded) {
      const canvas = Object.assign(document.createElement("canvas"), {
        width: copy.plain.width,
        height: copy.plain.height,
      });
      const pen = canvas.getContext("2d")!;
      pen.filter = "grayscale(0.8)";
      pen.globalAlpha = 0.6;
      pen.drawImage(copy.plain, 0, 0);
      copy.faded = canvas;
    }
    return copy.faded;
  }

  // Whether the frame pixel is drawn, or true when the image can't be read.
  function opaqueAt(sprite: LoadedSprite, pixel: { x: number; y: number }) {
    const { key, copy } = frameOf(sprite);
    let mask = alphaMasks.get(key);
    if (mask === undefined) {
      try {
        mask = copy.plain
          .getContext("2d", { willReadFrequently: true })!
          .getImageData(0, 0, copy.plain.width, copy.plain.height).data;
      } catch {
        mask = null;
      }
      alphaMasks.set(key, mask);
    }
    return !mask || (mask[(pixel.y * copy.plain.width + pixel.x) * 4 + 3] ?? 0) > 32;
  }

  function clearFrames() {
    frames.clear();
    alphaMasks.clear();
  }

  return { load, faded, opaqueAt, clearFrames };
}

export type Sprites = ReturnType<typeof makeSprites>;
export type LoadedSprite = NonNullable<ReturnType<Sprites["load"]>>;
