import type { ServedMap, ServedSystem } from "@rpgtl/contracts";
import { systemName } from "./commands.ts";

export interface EventPage {
  conditions: EventConditions;
  priorityType: number;
  through?: boolean;
  trigger: number;
  list: { code: number; indent?: number; parameters?: unknown[] }[];
  image: {
    characterName: string;
    characterIndex: number;
    direction: number;
    pattern: number;
    tileId: number;
  };
}
export interface EventConditions {
  switch1Valid: boolean;
  switch1Id: number;
  switch2Valid: boolean;
  switch2Id: number;
  variableValid: boolean;
  variableId: number;
  variableValue: number;
  selfSwitchValid: boolean;
  selfSwitchCh: string;
  itemValid: boolean;
  itemId: number;
  actorValid: boolean;
  actorId: number;
}
export interface MapEvent {
  characterName(): string;
  characterIndex(): number;
  direction(): number;
  pattern(): number;
  tileId(): number;
  eventId(): number;
  x: number;
  y: number;
  event(): { name: string; pages: EventPage[] };
  _mapId?: number;
  _pageIndex: number;
  _erased: boolean;
  _through?: boolean;
  isThrough?(): boolean;
  page(): EventPage | undefined;
}
export interface DataMapEvent {
  id?: number;
  name: string;
  x: number;
  y: number;
  pages: EventPage[];
}
export interface DataMap {
  displayName?: string;
  tilesetId: number;
  width: number;
  height: number;
  data: number[];
  events: (DataMapEvent | null)[];
  rpgtlNames?: ServedMap["rpgtlNames"];
}
interface GameMap {
  mapId(): number;
  tilesetId?(): number;
  width(): number;
  height(): number;
  isPassable(x: number, y: number, direction: number): boolean;
  isEventRunning?(): boolean;
  events(): MapEvent[];
  vehicles(): { _mapId: number; _type: string; x: number; y: number }[];
}
export interface MapGame {
  ImageManager?: { loadCharacter(name: string): CharacterBitmap };
  Input?: { clear?(): void };
  TouchInput?: { clear?(): void };
  DataManager?: { loadMapData(mapId: number): void };
  SceneManager?: { _scene?: unknown };
  Scene_Map?: new (...args: never[]) => unknown;
  $gameMap?: GameMap | null;
  $gamePlayer?: {
    x: number;
    y: number;
    locate?(x: number, y: number): void;
    reserveTransfer?(
      mapId: number,
      x: number,
      y: number,
      direction: number,
      fadeType: number,
    ): void;
    direction?(): number;
    isTransferring?(): boolean;
  };
  $dataMap?: DataMap | null;
  $dataMapInfos?: ({ name: string; parentId?: number; order?: number } | null)[];
  $dataTilesets?: ({ flags?: number[] } | null)[];
  $dataSystem?: {
    tileSize?: number;
    switches?: string[];
    variables?: string[];
    rpgtlNames?: ServedSystem["rpgtlNames"];
  };
  $dataItems?: ({ name?: string } | null)[];
  $dataActors?: ({ name?: string } | null)[];
  $gameSwitches?: { value(id: number): unknown };
  $gameVariables?: { value(id: number): unknown };
  $gameSelfSwitches?: {
    value(key: [number, number, string]): unknown;
    setValue?(key: [number, number, string], value: boolean): void;
  };
  $gameActors?: { actor(id: number): unknown };
  $gameParty?: {
    hasItem(item: unknown): boolean;
    members(): unknown[];
  };
}
export type Trigger = "action" | "player-touch" | "event-touch" | "autorun" | "parallel";
export type Priority = "below" | "same" | "above";
export interface Condition {
  text: string;
  holds: boolean;
}
export interface EventPageView {
  index: number;
  trigger: Trigger | null;
  priority: Priority;
  sprite: string;
  image?: CharacterSprite | undefined;
  conditions: Condition[];
  applies: boolean;
}
export interface CharacterBitmap {
  width: number;
  height: number;
  _image?: HTMLImageElement | null;
  canvas: HTMLCanvasElement;
  isReady(): boolean;
  addLoadListener(listener: () => void): void;
}
export interface CharacterSprite {
  characterName: string;
  characterIndex: number;
  direction: number;
  pattern: number;
}
export function standingFrame(
  name: string,
  width: number,
  height: number,
  index: number,
  direction: number,
  // Large objects such as houses are often split into several events that each show one frame.
  pattern = 1,
) {
  const big = /^[!$]+/.exec(name)?.[0].includes("$") ?? false;
  const frameWidth = width / (big ? 3 : 12);
  const frameHeight = height / (big ? 4 : 8);
  return {
    x: ((big ? 0 : (index % 4) * 3) + pattern) * frameWidth,
    y: ((big ? 0 : Math.floor(index / 4) * 4) + (direction - 2) / 2) * frameHeight,
    width: frameWidth,
    height: frameHeight,
  };
}
// The frame pixel under a point, for a frame drawn with its bottom center at (centerX, bottom)
// and `scale` screen pixels per frame pixel, or undefined outside the frame.
export function framePixelAt(
  frame: { width: number; height: number },
  centerX: number,
  bottom: number,
  scale: number,
  x: number,
  y: number,
) {
  const pixelX = Math.floor((x - centerX) / scale + frame.width / 2);
  const pixelY = Math.floor((y - bottom) / scale + frame.height);
  if (pixelX < 0 || pixelX >= frame.width || pixelY < 0 || pixelY >= frame.height) return undefined;
  return { x: pixelX, y: pixelY };
}
function characterSprite(image: EventPage["image"]): CharacterSprite | undefined {
  return image.characterName && !image.tileId
    ? {
        characterName: image.characterName,
        characterIndex: image.characterIndex,
        direction: image.direction,
        pattern: image.pattern,
      }
    : undefined;
}
export interface Marker {
  id: number;
  name: string;
  originalName?: string;
  x: number;
  y: number;
  trigger: Trigger | null;
  state: "active" | "empty" | "none";
  hidden: boolean;
  sprite?: CharacterSprite | undefined;
  blocks: boolean;
}
export interface MapSnapshot {
  mapId: number;
  width: number;
  height: number;
  tiles: Uint8Array;
  bounds: ContentBounds;
  player?: { x: number; y: number };
  vehicles: { type: string; x: number; y: number }[];
  markers: Marker[];
}
export interface ContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
const triggers: Trigger[] = ["action", "player-touch", "event-touch", "autorun", "parallel"];
const priorities: Priority[] = ["below", "same", "above"];
const grids = new WeakMap<
  GameMap,
  {
    mapId: number;
    tilesetId: number | undefined;
    tiles: Uint8Array;
    bounds: ContentBounds;
    // Tiles the game's own passability check has filled so far, which replace `tiles` once done.
    pending?: { tiles: Uint8Array; next: number } | undefined;
  }
>();
const dataGrids = new WeakMap<DataMap, Map<number, { tiles: Uint8Array; bounds: ContentBounds }>>();
const passageDirections = [2, 4, 6, 8];

function markerFromPage(
  id: number,
  name: string,
  translatedName: string | undefined,
  x: number,
  y: number,
  page: EventPage | undefined,
  through = false,
): Marker {
  return {
    id,
    name: translatedName || name,
    ...(translatedName && translatedName !== name && { originalName: name }),
    x,
    y,
    trigger: page ? (triggers[page.trigger] ?? null) : null,
    state: !page ? "none" : page.list.some((command) => command.code !== 0) ? "active" : "empty",
    hidden: !!page && !page.image.characterName && !page.image.tileId,
    sprite: page ? characterSprite(page.image) : undefined,
    blocks: !!page && page.priorityType === 1 && !through,
  };
}

function dataName(id: number, data: MapGame["$dataItems"]): string {
  const name = data?.[id]?.name;
  return name ? `${id} "${name}"` : String(id);
}

function systemLabel(game: MapGame, kind: "switch" | "variable", id: number): string {
  const name = systemName(game, kind, id);
  return name ? `${id} "${name}"` : String(id);
}

export function pageConditions(
  game: MapGame,
  mapId: number,
  eventId: number,
  page: EventPage,
): Condition[] {
  const c = page.conditions;
  const conditions: Condition[] = [];
  if (c.switch1Valid) {
    conditions.push({
      text: `Switch ${systemLabel(game, "switch", c.switch1Id)} is ON`,
      holds: !!game.$gameSwitches?.value(c.switch1Id),
    });
  }
  if (c.switch2Valid) {
    conditions.push({
      text: `Switch ${systemLabel(game, "switch", c.switch2Id)} is ON`,
      holds: !!game.$gameSwitches?.value(c.switch2Id),
    });
  }
  if (c.variableValid) {
    const value = game.$gameVariables?.value(c.variableId);
    conditions.push({
      text: `Variable ${systemLabel(game, "variable", c.variableId)} ≥ ${c.variableValue} (now ${value})`,
      holds: !((value as number) < c.variableValue),
    });
  }
  if (c.selfSwitchValid) {
    conditions.push({
      text: `Self switch ${c.selfSwitchCh} is ON`,
      holds: game.$gameSelfSwitches?.value([mapId, eventId, c.selfSwitchCh]) === true,
    });
  }
  if (c.itemValid) {
    const item = game.$dataItems?.[c.itemId];
    conditions.push({
      text: `Party has item ${dataName(c.itemId, game.$dataItems)}`,
      holds: !!game.$gameParty?.hasItem(item),
    });
  }
  if (c.actorValid) {
    const actor = game.$gameActors?.actor(c.actorId);
    conditions.push({
      text: `Actor ${dataName(c.actorId, game.$dataActors)} is in the party`,
      holds: !!actor && !!game.$gameParty?.members().includes(actor),
    });
  }
  return conditions;
}

export function standardPageIndex(
  game: MapGame,
  mapId: number,
  eventId: number,
  pages: EventPage[],
): number {
  for (let index = pages.length - 1; index >= 0; index--) {
    if (pageConditions(game, mapId, eventId, pages[index]!).every((condition) => condition.holds))
      return index;
  }
  return -1;
}

export function eventPages(game: MapGame, mapEvent: MapEvent): EventPageView[] {
  const event = mapEvent.event();
  const mapId = mapEvent._mapId ?? game.$gameMap?.mapId() ?? 0;
  return pagesForEvent(
    game,
    mapId,
    mapEvent.eventId(),
    event.pages,
    mapEvent._erased ? -1 : mapEvent._pageIndex,
  );
}

export function dataEventPages(
  game: MapGame,
  mapId: number,
  eventId: number,
  mapEvent: DataMapEvent,
): EventPageView[] {
  return pagesForEvent(
    game,
    mapId,
    eventId,
    mapEvent.pages,
    standardPageIndex(game, mapId, eventId, mapEvent.pages),
  );
}

function pagesForEvent(
  game: MapGame,
  mapId: number,
  eventId: number,
  pages: EventPage[],
  applies: number,
): EventPageView[] {
  return pages.map((page, index) => ({
    index,
    trigger: triggers[page.trigger] ?? null,
    priority: priorities[page.priorityType] ?? "same",
    sprite:
      page.image.tileId > 0 ? `tile ${page.image.tileId}` : page.image.characterName || "no sprite",
    image: characterSprite(page.image),
    conditions: pageConditions(game, mapId, eventId, page),
    applies: index === applies,
  }));
}

function vehicles(game: MapGame, mapId: number): MapSnapshot["vehicles"] {
  return (
    game.$gameMap
      ?.vehicles()
      .filter((vehicle) => vehicle._mapId === mapId)
      .map((vehicle) => ({ type: vehicle._type, x: vehicle.x, y: vehicle.y })) ?? []
  );
}

const voidTile = 0x10;
const wallPiece = 0x20;

/**
 * Marks a tile with no tile in any layer as void, and one whose bottom tile is a roof, wall top or
 * wall side (A3 and A4, IDs 4352 to 8191) as a wall piece. The editor leaves wall tops open along
 * the wall, so their passage alone would make a room's border look like floor.
 */
function tileKind(map: Pick<DataMap, "width" | "height" | "data">, x: number, y: number) {
  const at = (z: number) => map.data[(z * map.height + y) * map.width + x] ?? 0;
  const bottom = at(0);
  if (bottom >= 4352 && bottom < 8192) return wallPiece;
  return [0, 1, 2, 3].some((z) => at(z) !== 0) ? 0 : voidTile;
}

function tilesFromData(map: DataMap, flags: number[]): Uint8Array {
  const tiles = new Uint8Array(map.width * map.height);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const index = y * map.width + x;
      tiles[index] = tileKind(map, x, y);
      for (const direction of passageDirections) {
        const bit = (1 << (direction / 2 - 1)) & 0x0f;
        for (let z = 3; z >= 0; z--) {
          const tileId = map.data[(z * map.height + y) * map.width + x] ?? 0;
          const flag = flags[tileId] ?? 0;
          if (flag & 0x10) continue;
          if ((flag & bit) === 0) tiles[index] |= bit;
          break;
        }
      }
    }
  }
  return tiles;
}

export type TileLook = "void" | "wall" | "floor";

export function tileLook(snapshot: MapSnapshot, x: number, y: number): TileLook {
  const tile = snapshot.tiles[y * snapshot.width + x] ?? 0;
  if (tile & voidTile) return "void";
  return tile & wallPiece || !(tile & 0x0f) ? "wall" : "floor";
}

export function blockedSides(snapshot: MapSnapshot, x: number, y: number): number[] {
  if (tileLook(snapshot, x, y) !== "floor") return [];
  const tile = snapshot.tiles[y * snapshot.width + x] ?? 0;
  return passageDirections.filter((direction) => !(tile & (1 << (direction / 2 - 1))));
}

export function contentBounds(
  map: Pick<DataMap, "width" | "height" | "data">,
  positions: { x: number; y: number }[] = [],
): ContentBounds {
  let minX = map.width;
  let minY = map.height;
  let maxX = -1;
  let maxY = -1;
  let hasTiles = false;
  for (let z = 0; z < 4; z++) {
    const layerStart = z * map.width * map.height;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if ((map.data[layerStart + y * map.width + x] ?? 0) === 0) continue;
        hasTiles = true;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (!hasTiles) return { minX: 0, minY: 0, maxX: map.width - 1, maxY: map.height - 1 };
  for (const position of positions) {
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x);
    maxY = Math.max(maxY, position.y);
  }
  return {
    minX: Math.max(0, minX - 2),
    minY: Math.max(0, minY - 2),
    maxX: Math.min(map.width - 1, maxX + 2),
    maxY: Math.min(map.height - 1, maxY + 2),
  };
}

export function dataMapSnapshot(game: MapGame, mapId: number, map: DataMap): MapSnapshot {
  let maps = dataGrids.get(map);
  if (!maps) dataGrids.set(map, (maps = new Map()));
  let grid = maps.get(mapId);
  const markers = map.events
    .map((event, index) => {
      if (!event) return undefined;
      const eventId = event.id ?? index;
      const pageIndex = standardPageIndex(game, mapId, eventId, event.pages);
      const page = event.pages[pageIndex];
      return markerFromPage(
        eventId,
        event.name,
        map.rpgtlNames?.events?.[eventId],
        event.x,
        event.y,
        page,
        page?.through,
      );
    })
    .filter((marker): marker is Marker => !!marker)
    .toSorted((a, b) => a.id - b.id);
  const mapVehicles = vehicles(game, mapId);
  if (!grid) {
    grid = {
      tiles: tilesFromData(map, game.$dataTilesets?.[map.tilesetId]?.flags ?? []),
      bounds: contentBounds(map, [...markers, ...mapVehicles]),
    };
    maps.set(mapId, grid);
  }
  return {
    mapId,
    width: map.width,
    height: map.height,
    tiles: grid.tiles,
    bounds: grid.bounds,
    vehicles: mapVehicles,
    markers,
  };
}

/**
 * `deadline` (a `performance.now()` time) limits how long the game's passability check runs; the
 * grid shows what the map data says until the check has covered every tile.
 */
export function mapSnapshot(
  game: MapGame,
  refresh = false,
  deadline = Infinity,
): MapSnapshot | undefined {
  const map = game.$gameMap;
  const dataMap = game.$dataMap;
  if (!map || !map.mapId() || !dataMap) return undefined;
  const mapId = map.mapId();
  const width = map.width();
  const height = map.height();
  const tilesetId = map.tilesetId?.();
  let grid = grids.get(map);
  const changed = !grid || grid.mapId !== mapId || grid.tilesetId !== tilesetId;
  const markers = map
    .events()
    .map((event): Marker => {
      const page = event._pageIndex < 0 || event._erased ? undefined : event.page();
      const through = event.isThrough?.() ?? Reflect.get(event, "_through") ?? false;
      const marker = markerFromPage(
        event.eventId(),
        event.event().name,
        dataMap.rpgtlNames?.events?.[event.eventId()],
        event.x,
        event.y,
        page,
        through,
      );
      const image = {
        characterName: event.characterName(),
        characterIndex: event.characterIndex(),
        direction: event.direction(),
        pattern: event.pattern(),
        tileId: event.tileId(),
      };
      marker.sprite = page ? characterSprite(image) : undefined;
      marker.hidden = !!page && !image.characterName && !image.tileId;
      return marker;
    })
    .toSorted((a, b) => a.id - b.id);
  const mapVehicles = vehicles(game, mapId);
  if (changed || refresh) {
    const bounds = contentBounds(dataMap, [
      ...markers,
      { x: game.$gamePlayer!.x, y: game.$gamePlayer!.y },
      ...mapVehicles,
    ]);
    const pending = { tiles: new Uint8Array(width * height), next: 0 };
    if (changed || !grid) {
      const flags = game.$dataTilesets?.[tilesetId ?? dataMap.tilesetId]?.flags ?? [];
      grid = { mapId, tilesetId, tiles: tilesFromData(dataMap, flags), bounds, pending };
      grids.set(map, grid);
    } else Object.assign(grid, { bounds, pending });
  }
  const pending = grid!.pending;
  if (pending) {
    // Plugins can change passability, so the game's own check decides, at least a row at a time.
    while (pending.next < width * height) {
      const rowEnd = pending.next + width;
      for (let index = pending.next; index < rowEnd; index++) {
        const x = index % width,
          y = Math.floor(index / width);
        let tile = tileKind(dataMap, x, y);
        for (const direction of passageDirections) {
          if (map.isPassable(x, y, direction)) tile |= 1 << (direction / 2 - 1);
        }
        pending.tiles[index] = tile;
      }
      pending.next = rowEnd;
      if (performance.now() >= deadline) break;
    }
    if (pending.next >= width * height) {
      grid!.tiles = pending.tiles;
      grid!.pending = undefined;
    }
  }
  return {
    mapId,
    width,
    height,
    tiles: grid!.tiles,
    bounds: grid!.bounds,
    player: { x: game.$gamePlayer!.x, y: game.$gamePlayer!.y },
    vehicles: mapVehicles,
    markers,
  };
}

export function teleportTarget(
  snapshot: MapSnapshot,
  x: number,
  y: number,
): { x: number; y: number } | undefined {
  if (x < 0 || x >= snapshot.width || y < 0 || y >= snapshot.height) return undefined;
  const blocked = (tileX: number, tileY: number) =>
    tileLook(snapshot, tileX, tileY) !== "floor" ||
    snapshot.markers.some((marker) => marker.blocks && marker.x === tileX && marker.y === tileY);
  const queue = [{ x, y }];
  const seen = new Set([`${x},${y}`]);
  const directions: [number, number][] = [
    [0, 1],
    [-1, 0],
    [1, 0],
    [0, -1],
  ];
  while (queue.length) {
    const tile = queue.shift()!;
    if (!blocked(tile.x, tile.y)) return tile;
    for (const [dx, dy] of directions) {
      const nextX = tile.x + dx;
      const nextY = tile.y + dy;
      const key = `${nextX},${nextY}`;
      if (
        nextX >= 0 &&
        nextX < snapshot.width &&
        nextY >= 0 &&
        nextY < snapshot.height &&
        !seen.has(key)
      ) {
        seen.add(key);
        queue.push({ x: nextX, y: nextY });
      }
    }
  }
  return undefined;
}

export function teleport(game: MapGame, mapId: number, x: number, y: number): string | undefined {
  const sceneMap = game.Scene_Map;
  const scene = game.SceneManager?._scene;
  if (!sceneMap || !(scene instanceof sceneMap))
    return "Teleport is only available on the map scene.";
  if (game.$gameMap?.isEventRunning?.()) return "Cannot teleport while an event is running.";
  if (game.$gamePlayer?.isTransferring?.()) return "Cannot teleport while a transfer is pending.";
  const player = game.$gamePlayer;
  const currentMapId = game.$gameMap?.mapId();
  if (!player || currentMapId === undefined)
    return "Teleport is unavailable before the game starts or a save is loaded.";
  if (mapId === currentMapId) {
    if (!player.locate)
      return "Teleport is unavailable before the game starts or a save is loaded.";
    player.locate(x, y);
  } else {
    if (!player.reserveTransfer || !player.direction)
      return "Teleport is unavailable before the game starts or a save is loaded.";
    player.reserveTransfer(mapId, x, y, player.direction(), 2);
  }
  return undefined;
}

export function setSelfSwitch(
  game: MapGame,
  mapId: number,
  eventId: number,
  letter: string,
  value: boolean,
): void {
  game.$gameSelfSwitches?.setValue?.([mapId, eventId, letter], value);
}
