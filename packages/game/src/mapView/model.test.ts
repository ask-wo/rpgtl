import { expect, test } from "vite-plus/test";
import { decodeCommands, namesFromGame } from "./commands.ts";
import {
  dataEventPages,
  dataMapSnapshot,
  contentBounds,
  eventPages,
  framePixelAt,
  mapSnapshot,
  tileLook,
  blockedSides,
  pageConditions,
  setSelfSwitch,
  standardPageIndex,
  standingFrame,
  teleport,
  teleportTarget,
} from "./model.ts";
import type {
  DataMap,
  EventConditions,
  EventPage,
  MapEvent,
  MapGame,
  MapSnapshot,
  Marker,
} from "./model.ts";

const noConditions = (): EventConditions => ({
  switch1Valid: false,
  switch1Id: 0,
  switch2Valid: false,
  switch2Id: 0,
  variableValid: false,
  variableId: 0,
  variableValue: 0,
  selfSwitchValid: false,
  selfSwitchCh: "A",
  itemValid: false,
  itemId: 0,
  actorValid: false,
  actorId: 0,
});
const noConditionsBase = noConditions();
const page = (conditions: Partial<EventConditions>): EventPage => ({
  conditions: { ...noConditions(), ...conditions },
  priorityType: 1,
  trigger: 0,
  list: [{ code: 0 }],
  image: { characterName: "", characterIndex: 0, direction: 2, pattern: 1, tileId: 0 },
});
const dataPage = (
  conditions: EventConditions,
  list: { code: number }[],
  trigger = 0,
): EventPage => ({
  conditions,
  priorityType: 1,
  trigger,
  list,
  image: { characterName: "", characterIndex: 0, direction: 2, pattern: 1, tileId: 0 },
});

const event = (
  id: number,
  trigger = 0,
  overrides: Partial<MapEvent> = {},
  hidden = false,
): MapEvent => {
  const eventPage: EventPage = {
    conditions: noConditions(),
    priorityType: 1,
    trigger,
    list: [{ code: 101 }, { code: 0 }],
    image: {
      characterName: hidden ? "" : "Actor",
      characterIndex: 0,
      direction: 2,
      pattern: 1,
      tileId: 0,
    },
  };
  return {
    characterName: () => eventPage.image.characterName,
    characterIndex: () => eventPage.image.characterIndex,
    direction: () => eventPage.image.direction,
    pattern: () => eventPage.image.pattern,
    tileId: () => eventPage.image.tileId,
    eventId: () => id,
    x: id,
    y: 1,
    event: () => ({ name: `Event ${id}`, pages: [eventPage] }),
    _pageIndex: 0,
    _erased: false,
    page: () => eventPage,
    ...overrides,
  };
};

const targetSnapshot = (
  width: number,
  height: number,
  tiles: number[],
  markers: Marker[] = [],
): MapSnapshot => ({
  mapId: 1,
  width,
  height,
  tiles: new Uint8Array(tiles),
  bounds: { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 },
  vehicles: [],
  markers,
});
class Scene_Map {
  readonly marker = true;
}

test("Teleport target uses the nearest passable unblocked tile", () => {
  expect(teleportTarget(targetSnapshot(3, 3, [15, 15, 15, 15, 15, 15, 15, 15, 15]), 1, 1)).toEqual({
    x: 1,
    y: 1,
  });
  expect(teleportTarget(targetSnapshot(3, 3, [15, 15, 15, 15, 0, 15, 15, 15, 15]), 1, 1)).toEqual({
    x: 1,
    y: 2,
  });
  expect(
    teleportTarget(
      targetSnapshot(
        3,
        3,
        [15, 15, 15, 15, 15, 15, 15, 15, 15],
        [
          {
            id: 1,
            name: "Blocking",
            x: 1,
            y: 1,
            trigger: "action",
            state: "active",
            hidden: false,
            blocks: true,
          },
        ],
      ),
      1,
      1,
    ),
  ).toEqual({ x: 1, y: 2 });
  expect(
    teleportTarget(
      targetSnapshot(
        3,
        3,
        [15, 15, 15, 15, 15, 15, 15, 15, 15],
        [
          {
            id: 1,
            name: "Below",
            x: 1,
            y: 1,
            trigger: "action",
            state: "active",
            hidden: false,
            blocks: false,
          },
        ],
      ),
      1,
      1,
    ),
  ).toEqual({ x: 1, y: 1 });
  expect(teleportTarget(targetSnapshot(2, 2, [0, 0, 0, 0]), 0, 0)).toBeUndefined();
  expect(teleportTarget(targetSnapshot(3, 1, [0, 4, 15]), 0, 0)).toEqual({ x: 1, y: 0 });
});

test("Teleport locates or reserves a transfer and refuses unsafe states", () => {
  const located: [number, number][] = [];
  const transfers: [number, number, number, number, number][] = [];
  let eventRunning = false;
  let transferring = false;
  const player = {
    x: 0,
    y: 0,
    locate(x: number, y: number) {
      located.push([x, y]);
    },
    reserveTransfer(mapId: number, x: number, y: number, direction: number, fade: number) {
      transfers.push([mapId, x, y, direction, fade]);
    },
    direction: () => 6,
    isTransferring: () => transferring,
  };
  const game: MapGame = {
    Scene_Map,
    SceneManager: { _scene: new Scene_Map() },
    $gameMap: {
      mapId: () => 1,
      isEventRunning: () => eventRunning,
    } as NonNullable<MapGame["$gameMap"]>,
    $gamePlayer: player,
  };
  expect(teleport(game, 1, 4, 3)).toBeUndefined();
  expect(located).toEqual([[4, 3]]);
  expect(teleport(game, 2, 7, 5)).toBeUndefined();
  expect(transfers).toEqual([[2, 7, 5, 6, 2]]);

  eventRunning = true;
  expect(teleport(game, 1, 1, 1)).toMatch(/event is running/i);
  eventRunning = false;
  transferring = true;
  expect(teleport(game, 1, 1, 1)).toMatch(/transfer is pending/i);
  transferring = false;
  Reflect.set(game.SceneManager!, "_scene", {});
  expect(teleport(game, 1, 1, 1)).toMatch(/map scene/i);
  expect(located).toEqual([[4, 3]]);
  expect(transfers).toEqual([[2, 7, 5, 6, 2]]);
});

test("Self switch changes use the shown map ID", () => {
  const keys: [number, number, string][] = [];
  const game: MapGame = {
    $gameSelfSwitches: {
      value: () => false,
      setValue(key, value) {
        if (value) keys.push(key);
      },
    },
  };
  setSelfSwitch(game, 2, 4, "A", true);
  expect(keys).toEqual([[2, 4, "A"]]);
});

test("Snapshot of a map", () => {
  const emptyPage: EventPage = {
    conditions: noConditions(),
    priorityType: 1,
    trigger: 0,
    list: [{ code: 0 }],
    image: { characterName: "", characterIndex: 0, direction: 2, pattern: 1, tileId: 1 },
  };
  const game: MapGame = {
    $gamePlayer: { x: 2, y: 2 },
    $gameMap: {
      mapId: () => 1,
      width: () => 4,
      height: () => 3,
      isPassable: (x, y, d) => !(x === 0 && y === 0) && (!(x === 1 && y === 0) || d === 8),
      events: () => [
        event(9, 0, {}, true),
        event(8, 1, { _erased: true }),
        event(7, 0, { _pageIndex: -1, page: () => undefined }),
        event(6, 0, { page: () => emptyPage }),
        ...Array.from({ length: 5 }, (_, i) => event(i + 1, i)),
      ],
      vehicles: () => [
        { _mapId: 1, _type: "boat", x: 2, y: 1 },
        { _mapId: 2, _type: "ship", x: 0, y: 0 },
      ],
    },
  };
  game.$dataMap = {
    width: game.$gameMap!.width(),
    height: game.$gameMap!.height(),
    tilesetId: 1,
    data: [],
    events: [],
  };
  expect(mapSnapshot(game)).toEqual({
    mapId: 1,
    width: 4,
    height: 3,
    tiles: new Uint8Array([16, 24, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31]),
    bounds: { minX: 0, minY: 0, maxX: 3, maxY: 2 },
    player: { x: 2, y: 2 },
    vehicles: [{ type: "boat", x: 2, y: 1 }],
    markers: (
      [
        "action",
        "player-touch",
        "event-touch",
        "autorun",
        "parallel",
        "action",
        null,
        null,
        "action",
      ] as const
    ).map((trigger, i) => ({
      id: i + 1,
      name: `Event ${i + 1}`,
      x: i + 1,
      y: 1,
      trigger,
      state: i === 5 ? "empty" : i === 6 || i === 7 ? "none" : "active",
      hidden: i === 8,
      sprite:
        i < 6 ? { characterName: "Actor", characterIndex: 0, direction: 2, pattern: 1 } : undefined,
      blocks: i !== 6 && i !== 7,
    })),
  });
  game.$gameMap!.mapId = () => 0;
  expect(mapSnapshot(game)).toBeUndefined();
});

test("Player grid shows the map data first and the game's passability a row per call", () => {
  // Tile 1 blocks every side by its tileset flags; the game says only x = 1 is passable.
  const game: MapGame = {
    $gamePlayer: { x: 0, y: 0 },
    $dataTilesets: [null, { flags: [0x10, 0x0f] }],
    $gameMap: {
      mapId: () => 1,
      width: () => 2,
      height: () => 2,
      tilesetId: () => 1,
      isPassable: (x) => x === 1,
      events: () => [],
      vehicles: () => [],
    },
  };
  game.$dataMap = { width: 2, height: 2, tilesetId: 1, data: [1, 1, 1, 1], events: [] };
  const fromData = new Uint8Array([0, 0, 0, 0]);
  const fromGame = new Uint8Array([0, 15, 0, 15]);
  expect(mapSnapshot(game, false, 0)!.tiles).toEqual(fromData);
  expect(mapSnapshot(game, false, 0)!.tiles).toEqual(fromGame);
  game.$gameMap!.isPassable = () => true;
  // A refresh keeps showing the last grid until the new one is complete.
  expect(mapSnapshot(game, true, 0)!.tiles).toEqual(fromGame);
  expect(mapSnapshot(game, false, 0)!.tiles).toEqual(new Uint8Array(4).fill(15));
});

test("Content bounds include tiles and events with a clamped two-tile margin", () => {
  const width = 20;
  const height = 20;
  const data = Array.from({ length: 6 * width * height }, () => 0);
  for (let y = 3; y <= 5; y++)
    for (let x = 10; x <= 14; x++) data[(1 * height + y) * width + x] = 1;
  expect(contentBounds({ width, height, data }, [{ x: 2, y: 18 }])).toEqual({
    minX: 0,
    minY: 1,
    maxX: 16,
    maxY: 19,
  });
});

test("Tile looks from map data", () => {
  const width = 4;
  const height = 2;
  const data = Array.from({ length: 6 * width * height }, () => 0);
  const tile = (z: number, x: number, y: number, id: number) => {
    data[(z * height + y) * width + x] = id;
  };
  tile(0, 1, 0, 2);
  tile(0, 2, 0, 1);
  tile(2, 2, 0, 3);
  tile(0, 3, 0, 1);
  tile(2, 3, 0, 4);
  tile(0, 0, 1, 1);
  tile(2, 0, 1, 5);
  for (let x = 1; x < width; x++) tile(0, x, 1, 1);
  const map: DataMap = { width, height, tilesetId: 1, data, events: [] };
  const snapshot = dataMapSnapshot(
    { $dataTilesets: [null, { flags: [0x10, 0, 0x0f, 0x08, 0x8f, 0x10] }] },
    1,
    map,
  );
  expect(
    [0, 1, 2, 3, 4, 5].map((x) => tileLook(snapshot, x % width, Math.floor(x / width))),
  ).toEqual(["void", "wall", "floor", "wall", "floor", "floor"]);
  expect(blockedSides(snapshot, 2, 0)).toEqual([8]);
  expect(blockedSides(snapshot, 0, 1)).toEqual([]);
  // A wall top the editor leaves open along the wall, a wall side and a roof are walls.
  const pieces: DataMap = {
    width: 4,
    height: 1,
    tilesetId: 1,
    data: [5888, 5888 + 8 * 48, 4352, 2816, ...Array.from({ length: 20 }, () => 0)],
    events: [],
  };
  const flags: number[] = [];
  for (const id of [5888, 5888 + 8 * 48, 4352, 2816]) flags[id] = 0x06;
  const piecesSnapshot = dataMapSnapshot({ $dataTilesets: [null, { flags }] }, 1, pieces);
  expect([0, 1, 2, 3].map((x) => tileLook(piecesSnapshot, x, 0))).toEqual([
    "wall",
    "wall",
    "wall",
    "floor",
  ]);
  expect(blockedSides(piecesSnapshot, 0, 0)).toEqual([]);
});

test("Tile looks on the player's map", () => {
  const data = Array.from({ length: 18 }, () => 0);
  data[0] = 1;
  data[1] = 1;
  const game: MapGame = {
    $dataMap: { width: 3, height: 1, tilesetId: 1, data, events: [] },
    $gamePlayer: { x: 0, y: 0 },
    $gameMap: {
      mapId: () => 1,
      width: () => 3,
      height: () => 1,
      isPassable: (x, _y, direction) => (x === 1 ? direction !== 2 : x === 2),
      events: () => [],
      vehicles: () => [],
    },
  };
  const snapshot = mapSnapshot(game)!;
  expect([0, 1, 2].map((x) => tileLook(snapshot, x, 0))).toEqual(["wall", "floor", "void"]);
  expect(blockedSides(snapshot, 1, 0)).toEqual([2]);
});

test("Another map's markers use starting positions and live conditions", () => {
  const switchPage = dataPage({ ...noConditionsBase, switch1Valid: true, switch1Id: 1 }, [
    { code: 121 },
    { code: 0 },
  ]);
  const map: DataMap = {
    width: 3,
    height: 2,
    tilesetId: 1,
    data: Array.from({ length: 6 * 3 * 2 }, () => 1),
    events: [
      null,
      { name: "Switch", x: 1, y: 0, pages: [switchPage] },
      {
        name: "Action",
        x: 2,
        y: 1,
        pages: [dataPage({ ...noConditionsBase }, [{ code: 121 }, { code: 0 }])],
      },
      { name: "Empty", x: 1, y: 1, pages: [dataPage({ ...noConditionsBase }, [{ code: 0 }], 1)] },
    ],
  };
  let switchOn = false;
  const game: MapGame = {
    $dataTilesets: [null, { flags: [0, 0] }],
    $gameSwitches: { value: () => switchOn },
    $gameMap: { vehicles: () => [] } as unknown as NonNullable<MapGame["$gameMap"]>,
  };
  const snapshot = dataMapSnapshot(game, 2, map);
  expect(snapshot.player).toBeUndefined();
  expect(snapshot.markers).toMatchObject([
    { id: 1, x: 1, y: 0, state: "none" },
    { id: 2, x: 2, y: 1, state: "active" },
    { id: 3, x: 1, y: 1, state: "empty" },
  ]);
  switchOn = true;
  expect(dataMapSnapshot(game, 2, map).markers[0]?.state).toBe("active");
});

test("Map events, conditions and decoded commands use translated names with original fallbacks", () => {
  const condition = page({ switch1Valid: true, switch1Id: 1 });
  const map: DataMap = {
    width: 2,
    height: 1,
    tilesetId: 1,
    data: Array.from({ length: 12 }, () => 1),
    events: [null, { name: "客人1号", x: 0, y: 0, pages: [condition] }],
    rpgtlNames: { events: { "1": "Guest" } },
  };
  const game: MapGame = {
    $dataTilesets: [null, { flags: [0, 0] }],
    $dataSystem: {
      switches: ["", "门开了"],
      variables: ["", "任务进度"],
      rpgtlNames: { switches: { "1": "Door is open" }, variables: { "1": "Quest progress" } },
    },
    $gameSwitches: { value: () => true },
    $gameVariables: { value: () => 3 },
    $gameMap: { vehicles: () => [] } as unknown as NonNullable<MapGame["$gameMap"]>,
  };
  const marker = dataMapSnapshot(game, 2, map).markers[0]!;
  expect(marker).toMatchObject({ name: "Guest", originalName: "客人1号" });
  expect(pageConditions(game, 2, 1, condition)[0]?.text).toBe('Switch 1 "Door is open" is ON');
  const translated = decodeCommands(
    [
      { code: 121, indent: 0, parameters: [1, 1, 0] },
      { code: 355, indent: 0, parameters: ["$gameVariables.value(1);"] },
    ],
    namesFromGame(game as unknown as Parameters<typeof namesFromGame>[0]),
  );
  expect(translated.map((line) => line.detail)).toEqual([
    'Switch 1 "Door is open" = ON (now ON)',
    "$gameVariables.value(1) ‹Quest progress = 3›;",
  ]);

  const originalGame: MapGame = {
    ...game,
    $dataSystem: { switches: ["", "门开了"], variables: ["", "任务进度"] },
  };
  const { rpgtlNames: _, ...originalMap } = map;
  expect(dataMapSnapshot(originalGame, 2, originalMap).markers[0]?.name).toBe("客人1号");
  expect(pageConditions(originalGame, 2, 1, condition)[0]?.text).toBe('Switch 1 "门开了" is ON');
  expect(
    decodeCommands(
      [{ code: 121, indent: 0, parameters: [1, 1, 0] }],
      namesFromGame(originalGame as unknown as Parameters<typeof namesFromGame>[0]),
    )[0]?.detail,
  ).toBe('Switch 1 "门开了" = ON (now ON)');

  // An empty translation leaves the game's own name.
  const untranslated: MapGame = {
    ...originalGame,
    $dataSystem: { ...originalGame.$dataSystem, rpgtlNames: { switches: { "1": "" } } },
  };
  expect(pageConditions(untranslated, 2, 1, condition)[0]?.text).toBe('Switch 1 "门开了" is ON');
  expect(
    decodeCommands(
      [{ code: 121, indent: 0, parameters: [1, 1, 0] }],
      namesFromGame(untranslated as unknown as Parameters<typeof namesFromGame>[0]),
    )[0]?.detail,
  ).toBe('Switch 1 "门开了" = ON (now ON)');
});

test("Pages for a data event use the standard page index", () => {
  const pages = [page({}), page({ switch1Valid: true, switch1Id: 1 })];
  const game: MapGame = { $gameSwitches: { value: () => true } };
  expect(
    dataEventPages(game, 2, 1, { name: "Event", x: 0, y: 0, pages }).map((item) => item.applies),
  ).toEqual([false, true]);
});

test("Page conditions show their state and names", () => {
  const hero = {};
  const game: MapGame = {
    $dataSystem: {
      switches: ["", "Door open", "Second switch"],
      variables: ["", "", "Quest progress"],
    },
    $dataItems: [null, { name: "Potion" }],
    $dataActors: [null, { name: "Hero" }],
    $gameSwitches: { value: (id) => id === 1 },
    $gameVariables: { value: () => 1 },
    $gameSelfSwitches: { value: () => true },
    $gameActors: { actor: () => hero },
    $gameParty: { hasItem: () => false, members: () => [] },
  };
  const pages = [
    page({ switch1Valid: true, switch1Id: 1 }),
    page({ switch2Valid: true, switch2Id: 2 }),
    page({ variableValid: true, variableId: 2, variableValue: 1 }),
    page({ selfSwitchValid: true, selfSwitchCh: "A" }),
    page({ itemValid: true, itemId: 1 }),
    page({ actorValid: true, actorId: 1 }),
  ];
  expect(pages.map((item) => pageConditions(game, 3, 4, item))).toEqual([
    [{ text: 'Switch 1 "Door open" is ON', holds: true }],
    [{ text: 'Switch 2 "Second switch" is ON', holds: false }],
    [{ text: 'Variable 2 "Quest progress" ≥ 1 (now 1)', holds: true }],
    [{ text: "Self switch A is ON", holds: true }],
    [{ text: 'Party has item 1 "Potion"', holds: false }],
    [{ text: 'Actor 1 "Hero" is in the party', holds: false }],
  ]);
});

test("Event page index wins over standard condition order", () => {
  const game: MapGame = {
    $gameMap: { mapId: () => 1 } as NonNullable<MapGame["$gameMap"]>,
    $gameSwitches: { value: () => true },
  };
  const pages = [page({}), page({ switch1Valid: true, switch1Id: 1 })];
  const makeEvent = (erased: boolean): MapEvent => ({
    characterName: () => "",
    characterIndex: () => 0,
    direction: () => 2,
    pattern: () => 1,
    tileId: () => 0,
    eventId: () => 4,
    x: 0,
    y: 0,
    event: () => ({ name: "Event", pages }),
    _pageIndex: 0,
    _erased: erased,
    page: () => pages[0],
  });
  expect(eventPages(game, makeEvent(false)).map((item) => item.applies)).toEqual([true, false]);
  expect(eventPages(game, makeEvent(true)).map((item) => item.applies)).toEqual([false, false]);
});

test("Standard page index chooses the last page whose conditions hold", () => {
  let switches = new Set([1, 2]);
  let selfSwitch = true;
  const game: MapGame = {
    $gameSwitches: { value: (id) => switches.has(id) },
    $gameSelfSwitches: { value: () => selfSwitch },
  };
  const pages = [
    page({ switch1Valid: true, switch1Id: 1 }),
    page({ switch1Valid: true, switch1Id: 2 }),
    page({ selfSwitchValid: true, selfSwitchCh: "A" }),
  ];
  expect(standardPageIndex(game, 1, 4, pages)).toBe(2);
  selfSwitch = false;
  expect(standardPageIndex(game, 1, 4, pages)).toBe(1);
  switches = new Set();
  expect(standardPageIndex(game, 1, 4, pages)).toBe(-1);
});

test("A string variable uses the engine's less-than condition", () => {
  const game: MapGame = { $gameVariables: { value: () => "plugin value" } };
  const variablePage = page({ variableValid: true, variableId: 1, variableValue: 5 });
  expect(pageConditions(game, 1, 1, variablePage)[0]?.holds).toBe(true);
  expect(standardPageIndex(game, 1, 1, [page({}), variablePage])).toBe(1);
});

test("Standing frame cut-out for every character index and direction", () => {
  for (let index = 0; index < 8; index++) {
    for (const direction of [2, 4, 6, 8]) {
      expect(standingFrame("$Big", 192, 384, index, direction)).toEqual({
        x: 64,
        y: ((direction - 2) / 2) * 96,
        width: 64,
        height: 96,
      });
      expect(standingFrame("People1", 576, 384, index, direction)).toEqual({
        x: ((index % 4) * 3 + 1) * 48,
        y: (Math.floor(index / 4) * 4 + (direction - 2) / 2) * 48,
        width: 48,
        height: 48,
      });
    }
  }
  // Houses split into events each show the frame their page names.
  expect(standingFrame("$House", 3360, 2400, 0, 6, 2)).toEqual({
    x: 2240,
    y: 1200,
    width: 1120,
    height: 600,
  });
});

test("Frame pixel under a point of a sprite standing on a tile", () => {
  // A house frame of 1120 × 600 pixels drawn at half size, standing with its bottom center at
  // (300, 400), covers 20 to 580 across and 100 to 400 down.
  const frame = { width: 1120, height: 600 };
  expect(framePixelAt(frame, 300, 400, 0.5, 300, 399)).toEqual({ x: 560, y: 598 });
  expect(framePixelAt(frame, 300, 400, 0.5, 20, 100)).toEqual({ x: 0, y: 0 });
  expect(framePixelAt(frame, 300, 400, 0.5, 579.9, 399.9)).toEqual({ x: 1119, y: 599 });
  expect(framePixelAt(frame, 300, 400, 0.5, 19, 200)).toBeUndefined();
  expect(framePixelAt(frame, 300, 400, 0.5, 300, 400)).toBeUndefined();
  expect(framePixelAt(frame, 300, 400, 0.5, 300, 99)).toBeUndefined();
});

test("Live sprite look on the player's map and page look elsewhere", () => {
  const eventPage = page({});
  eventPage.image = {
    characterName: "People1",
    characterIndex: 2,
    direction: 2,
    pattern: 0,
    tileId: 0,
  };
  const live = event(1, 0, {
    page: () => eventPage,
    event: () => ({ name: "Actor", pages: [eventPage] }),
    characterName: () => "$Big",
    characterIndex: () => 0,
    direction: () => 4,
    pattern: () => 2,
  });
  const tile = event(2, 0, {
    tileId: () => 12,
    page: () => ({ ...eventPage, image: { ...eventPage.image, tileId: 12 } }),
  });
  const erased = event(3, 0, { _erased: true });
  const map: DataMap = {
    width: 4,
    height: 4,
    tilesetId: 1,
    data: Array(96).fill(1),
    events: [
      null,
      { id: 1, name: "Actor", x: 1, y: 1, pages: [eventPage] },
      { id: 2, name: "Tile", x: 2, y: 1, pages: [tile.page()!] },
    ],
  };
  const game: MapGame = {
    $dataMap: map,
    $gamePlayer: { x: 0, y: 0 },
    $gameMap: {
      mapId: () => 1,
      width: () => 4,
      height: () => 4,
      isPassable: () => true,
      events: () => [live, tile, erased],
      vehicles: () => [],
    },
  };
  expect(mapSnapshot(game)!.markers.map((marker) => marker.sprite)).toEqual([
    { characterName: "$Big", characterIndex: 0, direction: 4, pattern: 2 },
    undefined,
    undefined,
  ]);
  expect(dataMapSnapshot(game, 2, map).markers.map((marker) => marker.sprite)).toEqual([
    { characterName: "People1", characterIndex: 2, direction: 2, pattern: 0 },
    undefined,
  ]);
});
