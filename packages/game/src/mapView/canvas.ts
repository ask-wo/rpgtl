import { blockedSides, framePixelAt, tileLook } from "./model.ts";
import type { MapSnapshot, Marker, TileLook } from "./model.ts";
import { drawStandingMarker } from "./markers.ts";
import type { Sprites } from "./sprites.ts";

export const tileColors: Record<TileLook, string> = {
  void: "#0b111c",
  wall: "#3b4b64",
  floor: "#8295ae",
};
export const blockedColor = "#ff8b8b";

/** Where the map is drawn: each tile's size and the map's top left corner, in CSS pixels. */
export interface Camera {
  tile: number;
  offsetX: number;
  offsetY: number;
}

// Lower rows draw over the sprites of higher ones, as in the game.
const drawOrder = (markers: ReadonlyArray<Marker>) =>
  markers.toSorted((a, b) => a.y - b.y || a.x - b.x || a.id - b.id);

const rgba = (hex: string) => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
  255,
];

/**
 * The camera that fits the map's content into a viewport `width` by `height`, and the smallest
 * tile size zooming out may reach, where the whole map fits.
 */
export function fit(snapshot: MapSnapshot, width: number, height: number) {
  const contentWidth = snapshot.bounds.maxX - snapshot.bounds.minX + 1;
  const contentHeight = snapshot.bounds.maxY - snapshot.bounds.minY + 1;
  const smallest = Math.min(
    48,
    Math.max(1, width - 24) / snapshot.width,
    Math.max(1, height - 24) / snapshot.height,
  );
  const tile = Math.min(
    48,
    Math.max(1, width - 24) / contentWidth,
    Math.max(1, height - 24) / contentHeight,
  );
  const camera: Camera = {
    tile,
    offsetX: (width - contentWidth * tile) / 2 - snapshot.bounds.minX * tile,
    offsetY: (height - contentHeight * tile) / 2 - snapshot.bounds.minY * tile,
  };
  return { camera, smallest };
}

const grids = new WeakMap<Uint8Array, HTMLCanvasElement>();

// One pixel per tile, scaled up without smoothing, so tiles stay crisp at any zoom.
function gridOf(snapshot: MapSnapshot) {
  let grid = grids.get(snapshot.tiles);
  if (grid) return grid;
  grid = document.createElement("canvas");
  grid.width = snapshot.width;
  grid.height = snapshot.height;
  const pen = grid.getContext("2d")!;
  const image = pen.createImageData(snapshot.width, snapshot.height);
  const colors = {
    void: rgba(tileColors.void),
    wall: rgba(tileColors.wall),
    floor: rgba(tileColors.floor),
  };
  for (let index = 0; index < snapshot.tiles.length; index++) {
    const look = tileLook(snapshot, index % snapshot.width, Math.floor(index / snapshot.width));
    image.data.set(colors[look], index * 4);
  }
  pen.putImageData(image, 0, 0);
  grids.set(snapshot.tiles, grid);
  return grid;
}

export interface Marks {
  readonly event?: number | undefined;
  readonly tile?: { readonly x: number; readonly y: number } | undefined;
}

export function drawMap(
  pen: CanvasRenderingContext2D,
  snapshot: MapSnapshot,
  { tile, offsetX, offsetY }: Camera,
  viewport: { readonly width: number; readonly height: number },
  marks: Marks,
  sprites: Sprites,
) {
  pen.clearRect(0, 0, viewport.width, viewport.height);
  pen.imageSmoothingEnabled = false;
  pen.drawImage(gridOf(snapshot), offsetX, offsetY, snapshot.width * tile, snapshot.height * tile);
  if (tile >= 8) {
    const firstX = Math.max(0, Math.floor(-offsetX / tile));
    const lastX = Math.min(snapshot.width, Math.ceil((viewport.width - offsetX) / tile));
    const firstY = Math.max(0, Math.floor(-offsetY / tile));
    const lastY = Math.min(snapshot.height, Math.ceil((viewport.height - offsetY) / tile));
    pen.strokeStyle = "#52627b";
    pen.lineWidth = 0.5;
    pen.beginPath();
    for (let x = firstX; x <= lastX; x++) {
      pen.moveTo(offsetX + x * tile, offsetY + firstY * tile);
      pen.lineTo(offsetX + x * tile, offsetY + lastY * tile);
    }
    for (let y = firstY; y <= lastY; y++) {
      pen.moveTo(offsetX + firstX * tile, offsetY + y * tile);
      pen.lineTo(offsetX + lastX * tile, offsetY + y * tile);
    }
    pen.stroke();
    pen.strokeStyle = blockedColor;
    pen.lineWidth = Math.max(1.5, tile * 0.1);
    pen.beginPath();
    for (let y = firstY; y < lastY; y++) {
      for (let x = firstX; x < lastX; x++) {
        if (tileLook(snapshot, x, y) !== "floor") continue;
        const left = offsetX + x * tile;
        const top = offsetY + y * tile;
        for (const direction of blockedSides(snapshot, x, y)) {
          if (direction === 2) {
            pen.moveTo(left, top + tile);
            pen.lineTo(left + tile, top + tile);
          } else if (direction === 4) {
            pen.moveTo(left, top);
            pen.lineTo(left, top + tile);
          } else if (direction === 6) {
            pen.moveTo(left + tile, top);
            pen.lineTo(left + tile, top + tile);
          } else {
            pen.moveTo(left, top);
            pen.lineTo(left + tile, top);
          }
        }
      }
    }
    pen.stroke();
  }
  const visible = (x: number, y: number) =>
    x >= -tile && y >= -tile && x <= viewport.width + tile && y <= viewport.height + tile;
  for (const vehicle of snapshot.vehicles) {
    const x = offsetX + (vehicle.x + 0.5) * tile,
      y = offsetY + (vehicle.y + 0.5) * tile;
    if (!visible(x, y)) continue;
    pen.fillStyle = "#74c5ed";
    pen.fillRect(x - tile * 0.25, y - tile * 0.25, tile * 0.5, tile * 0.5);
    pen.font = "11px system-ui";
    pen.textAlign = "center";
    pen.fillStyle = "#e7edf7";
    pen.fillText(vehicle.type, x, y + tile * 0.5 + 10);
  }
  for (const marker of drawOrder(snapshot.markers)) {
    const x = offsetX + (marker.x + 0.5) * tile,
      y = offsetY + (marker.y + 0.5) * tile;
    const sprite = marker.sprite && sprites.load(marker.sprite);
    const halfWidth = sprite ? (sprite.tilesWide * tile) / 2 : tile / 2;
    const spriteHeight = sprite ? sprite.tilesHigh * tile : tile;
    if (
      x + halfWidth < 0 ||
      x - halfWidth > viewport.width ||
      y + tile / 2 + 14 < 0 ||
      y + tile / 2 - spriteHeight > viewport.height
    )
      continue;
    drawStandingMarker(pen, marker, x, y, tile, sprites);
    if (marks.event === marker.id) {
      pen.setLineDash([]);
      pen.strokeStyle = "#ffffff";
      pen.lineWidth = 2;
      pen.strokeRect(x - tile * 0.48, y - tile * 0.48, tile * 0.96, tile * 0.96);
    }
  }
  if (marks.tile) {
    const x = offsetX + (marks.tile.x + 0.5) * tile;
    const y = offsetY + (marks.tile.y + 0.5) * tile;
    if (visible(x, y)) {
      pen.save();
      pen.setLineDash([4, 2]);
      pen.strokeStyle = "#56e39a";
      pen.lineWidth = 2;
      pen.strokeRect(x - tile * 0.48, y - tile * 0.48, tile * 0.96, tile * 0.96);
      pen.restore();
    }
  }
  if (snapshot.player) {
    pen.beginPath();
    pen.arc(
      offsetX + (snapshot.player.x + 0.5) * tile,
      offsetY + (snapshot.player.y + 0.5) * tile,
      tile * 0.22,
      0,
      Math.PI * 2,
    );
    pen.fillStyle = "#56e39a";
    pen.fill();
    pen.strokeStyle = "#111c2e";
    pen.lineWidth = 2;
    pen.stroke();
  }
}

/**
 * The topmost marker at a point in the viewport: on its tile, or on a drawn pixel of its sprite,
 * which can reach into the tiles around it.
 */
export function markerAt(
  snapshot: MapSnapshot,
  { tile, offsetX, offsetY }: Camera,
  sprites: Sprites,
  x: number,
  y: number,
) {
  return drawOrder(snapshot.markers).findLast((marker) => {
    const centerX = offsetX + (marker.x + 0.5) * tile;
    const centerY = offsetY + (marker.y + 0.5) * tile;
    if (Math.hypot(centerX - x, centerY - y) <= tile * 0.48) return true;
    const sprite = marker.state !== "none" && marker.sprite && sprites.load(marker.sprite);
    if (!sprite) return false;
    const scale = (sprite.tilesWide * tile) / sprite.rect.width;
    const pixel = framePixelAt(sprite.rect, centerX, centerY + tile / 2, scale, x, y);
    return !!pixel && sprites.opaqueAt(sprite, pixel);
  });
}

export function tileAt(
  snapshot: MapSnapshot,
  { tile, offsetX, offsetY }: Camera,
  x: number,
  y: number,
) {
  const tileX = Math.floor((x - offsetX) / tile);
  const tileY = Math.floor((y - offsetY) / tile);
  if (tileX < 0 || tileX >= snapshot.width || tileY < 0 || tileY >= snapshot.height)
    return undefined;
  return { x: tileX, y: tileY };
}
