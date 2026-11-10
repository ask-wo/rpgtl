import { expect, test } from "vite-plus/test";
import { fit, markerAt } from "./canvas.ts";
import type { MapSnapshot, Marker } from "./model.ts";
import { makeSprites } from "./sprites.ts";

const marker = (id: number, x: number, y: number): Marker => ({
  id,
  name: `Event ${id}`,
  x,
  y,
  trigger: "action",
  state: "active",
  hidden: false,
  blocks: false,
});

const snapshot = (markers: Marker[] = []): MapSnapshot => ({
  mapId: 1,
  width: 20,
  height: 10,
  tiles: new Uint8Array(200),
  bounds: { minX: 5, minY: 2, maxX: 14, maxY: 6 },
  vehicles: [],
  markers,
});

// A game without an image manager has no sprites, so markers are hit on their tile only.
const sprites = makeSprites({}, () => {});

test("fitting centres the map's content and lets zooming out reach the whole map", () => {
  const { camera, smallest } = fit(snapshot(), 424, 224);
  expect(camera.tile).toBe(40);
  expect(camera.offsetX).toBe(12 - 5 * 40);
  expect(camera.offsetY).toBe(12 - 2 * 40);
  expect(smallest).toBe(20);
  expect(fit(snapshot(), 4000, 4000).camera.tile).toBe(48);
});

test("a point finds the marker drawn on top where two share a tile", () => {
  const camera = { tile: 10, offsetX: 0, offsetY: 0 };
  const map = snapshot([marker(2, 3, 4), marker(1, 3, 4), marker(3, 6, 1)]);
  expect(markerAt(map, camera, sprites, 35, 45)?.id).toBe(2);
  expect(markerAt(map, camera, sprites, 65, 15)?.id).toBe(3);
  expect(markerAt(map, camera, sprites, 15, 15)).toBeUndefined();
});
