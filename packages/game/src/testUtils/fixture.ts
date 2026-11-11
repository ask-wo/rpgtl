import { expect } from "vite-plus/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyTranslations, erasedName, GameFile, imageBlocks } from "@rpgtl/domain";
import * as Result from "effect/Result";
import { buildScript } from "../build.ts";
import { type Engine, type Entry, gameFiles } from "@rpgtl/contracts";
import { png } from "./png.ts";

// Stand-ins for the engine globals that the runtime touches.
const coreScript = `
  // The loading hooks of the real Bitmap in both engines, so the runtime's hooks run unchanged.
  // MV draws the image into a canvas as soon as it is loaded; MZ keeps the image until the context
  // is asked for, then copies it to a canvas.
  window.Bitmap = function Bitmap(url) {
    this._url = url;
    this._loadingState = "loading";
    this._loadListeners = [];
    this._image = new Image();
    this._image.onload = this._onLoad.bind(this);
    this._image.onerror = this._onError.bind(this);
    this._image.src = url;
  };
  Bitmap.prototype.isReady = function () {
    return this._loadingState === "loaded" || this._loadingState === "none";
  };
  Bitmap.prototype.addLoadListener = function (listener) {
    if (this.isReady()) listener(this); else this._loadListeners.push(listener);
  };
  Bitmap.prototype._callLoadListeners = function () {
    while (this._loadListeners.length) this._loadListeners.shift()(this);
  };
  Bitmap.prototype._onError = function () { throw new Error("Missing fixture image: " + this._url); };
  Bitmap.prototype._createCanvas = function () {
    this._canvas = document.createElement("canvas");
    this._canvas.width = this._image.width;
    this._canvas.height = this._image.height;
    this._context = this._canvas.getContext("2d");
    this._context.drawImage(this._image, 0, 0);
  };
  Bitmap.prototype._setDirty = function () { this.dirtied = (this.dirtied ?? 0) + 1; };
  Object.defineProperty(Bitmap.prototype, "context", {
    get() {
      if (!this._canvas) {
        this._createCanvas();
        this._baseTexture = { updates: 0, update() { this.updates++; } };
      }
      return this._context;
    },
  });
  Bitmap.prototype._onLoad = function () {
    this.width = this._image.width;
    this.height = this._image.height;
    if (window.__fixtureEngine === "MV") {
      this._createCanvas();
      this.canvas = this._canvas;
      this._image = null;
    }
    this._loadingState = "loaded";
    this._callLoadListeners();
  };
  const bitmapCache = new Map();
  window.ImageManager = {
    loadBitmap(folder, name) {
      const url = folder + encodeURIComponent(name) + ".png";
      if (!bitmapCache.has(url)) bitmapCache.set(url, new Bitmap(url));
      return bitmapCache.get(url);
    },
    loadCharacter(name) { return this.loadBitmap("img/characters/", name); },
    isBigCharacter(name) { return /^[!$]+/.exec(name)?.[0].includes("$") ?? false; },
  };
  window.Scene_Map = function Scene_Map() {};
  window.SceneManager = {
    _scene: new window.Scene_Map(),
    run() {},
  };
  window.StorageManager = { webStorageKey: (id) => "RPG File" + id };
  window.Game_Player = function () {};
  Game_Player.prototype.executeEncounter = () => true;
  Game_Player.prototype.setThrough = function (value) { this.through = value; };
  Game_Player.prototype.isThrough = function () { return !!this.through; };
  window.$gamePlayer = new Game_Player();
  window.$gamePlayer.x = 5;
  window.$gamePlayer.y = 5;
  window.$gamePlayer._direction = 2;
  window.$gamePlayer._transferring = false;
  window.$gamePlayer.locateCalls = [];
  window.$gamePlayer.reserveTransferCalls = [];
  Game_Player.prototype.locate = function (x, y) {
    this.locateCalls.push([x, y]);
    this.x = x;
    this.y = y;
  };
  Game_Player.prototype.reserveTransfer = function (mapId, x, y, direction, fadeType) {
    this.reserveTransferCalls.push([mapId, x, y, direction, fadeType]);
    this.x = x;
    this.y = y;
    this._transferring = true;
  };
  Game_Player.prototype.direction = function () { return this._direction; };
  Game_Player.prototype.isTransferring = function () { return this._transferring; };
  window.$dataMap = {
    displayName: "Fixture Forest",
    width: 40,
    height: 24,
    tilesetId: 1,
    data: Array.from({ length: 6 * 40 * 24 }, (_, index) => {
      const layerSize = 40 * 24;
      const x = index % 40;
      const y = Math.floor(index / 40) % 24;
      const z = Math.floor(index / layerSize);
      if (z === 2 && x === 4 && y === 4) return 3;
      if (z !== 0 || x < 1 || x > 9 || y < 1 || y > 6) return 0;
      return x === 1 || x === 9 || y === 1 || y === 6 ? 2 : 1;
    }),
  };
  window.DataManager = { loadMapData(mapId) { this.requestedMapId = mapId; window.$dataMap = null; } };
  window.$dataMapInfos = [
    null,
    { name: "Forest", parentId: 0, order: 1 },
    { name: "Second Field", parentId: 1, order: 2 },
  ];
  window.$dataTilesets = [null, { flags: [0x10, 0, 0x0f, 0x08] }];
  window.$dataCommonEvents = [null, {
    name: "Internal event",
    list: [
      { code: 101, indent: 0, parameters: ["", 0, 0, 2, "Guide"] },
      { code: 401, indent: 0, parameters: ["From the common event."] },
      { code: 117, indent: 0, parameters: [1] },
      { code: 0, indent: 0, parameters: [] },
    ],
  }];
  const conditions = (overrides = {}) => ({
    switch1Valid: false, switch1Id: 0,
    switch2Valid: false, switch2Id: 0,
    variableValid: false, variableId: 0, variableValue: 0,
    selfSwitchValid: false, selfSwitchCh: "A",
    itemValid: false, itemId: 0,
    actorValid: false, actorId: 0,
    ...overrides,
  });
  const mapEvents = Array.from({ length: 7 }, (_, index) => {
    const page = {
      conditions: conditions(), priorityType: 1,
      trigger: index < 5 ? index : 0,
      list: index === 0 ? [
        { code: 101, indent: 0, parameters: ["", 0, 0, 2, "Guide"] },
        { code: 401, indent: 0, parameters: ["Welcome!"] },
        { code: 401, indent: 0, parameters: ["Stay a while."] },
        { code: 102, indent: 0, parameters: [["Yes", "No"], -2, 0, 2, 0] },
        { code: 402, indent: 0, parameters: [0, "Yes"] },
        { code: 121, indent: 1, parameters: [1, 1, 0] },
        { code: 402, indent: 0, parameters: [1, "No"] },
        { code: 122, indent: 1, parameters: [1, 1, 0, 0, 1] },
        { code: 404, indent: 0, parameters: [] },
        { code: 111, indent: 0, parameters: [0, 1, 0] },
        { code: 121, indent: 1, parameters: [1, 1, 0] },
        { code: 411, indent: 0, parameters: [] },
        { code: 122, indent: 1, parameters: [1, 1, 0, 0, 2] },
        { code: 412, indent: 0, parameters: [] },
        { code: 121, indent: 0, parameters: [1, 1, 0] },
        { code: 201, indent: 0, parameters: [0, 1, 3, 4, 0, 0] },
        { code: 117, indent: 0, parameters: [1] },
        { code: 0, indent: 0, parameters: [] },
      ] : index === 5 ? [{ code: 0, parameters: [] }] : [{ code: 101, parameters: [] }, { code: 0, parameters: [] }],
      image: { characterName: index === 4 || index === 5 ? "" : index === 3 ? "Actor1" : index === 2 ? "$Big" : "People1", characterIndex: index === 1 ? 6 : 2, direction: [2, 6, 4, 2, 2, 2, 2][index], tileId: index === 5 ? 1 : 0 },
    };
    const pages = index === 0 ? [
      page,
      { ...page, image: { ...page.image, characterIndex: 7, direction: 6 }, conditions: conditions({ switch1Valid: true, switch1Id: 1 }) },
      { ...page, image: { ...page.image, characterName: "$Big", direction: 8 }, conditions: conditions({ selfSwitchValid: true, selfSwitchCh: "A" }) },
    ] : [page];
    return {
      characterName() { return this.page()?.image.characterName ?? ""; },
      characterIndex() { return this.page()?.image.characterIndex ?? 0; },
      pattern() { return this.page()?.image.pattern ?? 1; },
      direction() { return this._direction; },
      tileId() { return this.page()?.image.tileId ?? 0; },
      _direction: page.image.direction,
      eventId: () => index + 1,
      x: 2 + index, y: index < 5 ? 2 : 4,
      event: () => ({ name: ["客人1号", "EV001", "巡逻员", "Introduction", "Watcher", "Finished", "Unavailable"][index], pages }),
      _mapId: 1, _pageIndex: index === 6 ? -1 : 0, _erased: false,
      page() { return this._pageIndex < 0 ? undefined : pages[this._pageIndex]; },
    };
  });
  window.$gameMap = {
    eventRunning: false,
    refreshRequested: false,
    _mapId: 1, _tilesetId: 1,
    mapId() { return this._mapId; }, tilesetId() { return this._tilesetId; },
    width: () => $dataMap.width, height: () => $dataMap.height,
    isEventRunning() { return this.eventRunning; },
    requestRefresh() {
      this.refreshRequested = true;
      if (this._mapId === 1) {
        mapEvents[0]._pageIndex = $gameSelfSwitches.value([1,1,"A"]) ? 2 : $gameSwitches.value(1) ? 1 : 0;
      }
    },
    isPassable: (x, y, direction) =>
      x >= 1 && x <= 9 && y >= 1 && y <= 6 &&
      !(x === 1 || x === 9 || y === 1 || y === 6) &&
      !(x === 4 && y === 4 && direction === 8),
    events: () => mapEvents,
    vehicles: () => [{ _mapId: 1, _type: "boat", x: 2, y: 6 }],
  };
  window.$dataMap.events = [null, ...mapEvents.map(event => ({ ...event.event(), id: event.eventId(), x: event.x, y: event.y }))];
  window.Input = { clear() { window.heldGameKeys = {}; this.clearCalls = (this.clearCalls ?? 0) + 1; } };
  window.TouchInput = { clear() { this.clearCalls = (this.clearCalls ?? 0) + 1; } };
  document.addEventListener("keydown", (e) => {
    (window.gameKeys ??= []).push(e.code);
    (window.heldGameKeys ??= {})[e.code] = true;
  });
  document.addEventListener("keyup", (e) => {
    (window.gameKeyUps ??= []).push(e.code);
    (window.heldGameKeys ??= {})[e.code] = false;
  });
  window.setupFixtureMap = function (mapId, data) {
    window.$dataMap = data;
    $gameMap._mapId = mapId;
    $gameMap._tilesetId = data.tilesetId;
    $gamePlayer._transferring = false;
    const loadedEvents = data.events.flatMap((event, id) => event ? [{
      characterName() { return this.page().image.characterName; },
      characterIndex() { return this.page().image.characterIndex; },
      pattern() { return this.page().image.pattern; },
      direction() { return this._direction; },
      tileId() { return this.page().image.tileId; },
      _direction: event.pages[0].image.direction,
      eventId: () => event.id ?? id, x: event.x, y: event.y,
      event: () => event, _mapId: mapId, _pageIndex: 0, _erased: false,
      page: () => event.pages[0],
    }] : []);
    $gameMap.events = () => loadedEvents;
  };
  window.$dataSystem = { variables: ["", "任务进度", "好感度"], switches: ["", "门开了"] };
  window.$dataActors = [null, { name: "Hero" }];
  window.$dataItems = [null, { name: "Potion" }];
  window.$dataWeapons = [null, { name: "Sword" }];
  window.$dataArmors = [null, { name: "Shield" }];
  const hero = {
    recoverAll() { this.healed = true; },
    addParam(id, bonus) { this.bonus = bonus; },
  };
  window.$gameActors = { actor: () => hero };
  window.$gameVariables = { value(id) { return this[id] ?? 0; }, setValue(id, value) { this[id] = value; } };
  window.$gameSwitches = { value(id) { return !!this[id]; }, setValue(id, value) { this[id] = value; } };
  window.$gameSelfSwitches = {
    value(key) { return !!this[key.join(",")]; },
    setValue(key, value) {
      this[key.join(",")] = !!value;
      $gameMap.requestRefresh();
    },
  };
  window.$gameParty = {
    amount: 0,
    gold() { return this.amount; },
    gainGold(value) { this.amount += value; },
    members: () => [hero],
    hasItem(item) { return this.item === item && this.quantity > 0; },
    gainItem(item, n) { this.item = item; this.quantity = n; },
  };
  window.addEventListener("load", () => window.SceneManager.run());
`;

const data = {
  "System.json": {
    gameTitle: "Fixture Adventure",
    currencyUnit: "Gold",
    terms: { basic: ["Level", "HP"], messages: { victory: "%1 wins!" } },
    variables: ["", "任务进度", "好感度"],
    switches: ["", "门开了"],
    hasEncryptedImages: true,
  },
  "Actors.json": [
    null,
    {
      name: "Hero",
      nickname: "Traveler",
      profile: "A brave explorer",
      note: "<plugin:do not touch>",
      characterName: "Actor1",
    },
  ],
  "Items.json": [null, { name: "Potion", description: "Recover \\V[1] HP." }],
  "CommonEvents.json": [
    null,
    {
      name: "Internal event",
      list: [
        { code: 401, parameters: ["Hello \\N[1]!"] },
        { code: 355, parameters: ['console.log("do not translate")'] },
        { code: 122, parameters: [1, 1, 0, 4, "code()"] },
      ],
    },
  ],
  "Map001.json": {
    displayName: "Forest",
    events: [
      null,
      {
        name: "客人1号",
        pages: [
          {
            list: [
              { code: 101, parameters: ["", 0, 0, 2, "Guide"] },
              { code: 401, parameters: ["Welcome!"] },
              { code: 401, parameters: [""] },
              { code: 401, parameters: ["Stay a while."] },
              { code: 102, parameters: [["Yes", "No"], 0] },
              { code: 402, parameters: [0, "Yes"] },
              { code: 405, parameters: ["Long ago…"] },
              { code: 405, parameters: ["in a far land."] },
            ],
          },
        ],
      },
      { name: "EV001", pages: [] },
    ],
  },
  "Map002.json": {
    width: 8,
    height: 7,
    tilesetId: 1,
    data: Array.from({ length: 6 }, (_layer, z) =>
      Array.from({ length: 7 }, (_row, y) =>
        Array.from({ length: 8 }, (_column, x) =>
          z === 0
            ? x < 1 || x > 6 || y < 1 || y > 5
              ? 0
              : x === 1 || x === 6 || y === 1 || y === 5
                ? 2
                : 1
            : z === 2 && x === 3 && y === 3
              ? 3
              : 0,
        ),
      ).flat(),
    ).flat(),
    events: [
      null,
      {
        name: "Switch event",
        x: 1,
        y: 1,
        pages: [
          {
            conditions: {
              switch1Valid: true,
              switch1Id: 1,
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
            },
            priorityType: 1,
            trigger: 0,
            list: [
              { code: 121, parameters: [1, 1, 0] },
              { code: 0, parameters: [] },
            ],
            image: { characterName: "", characterIndex: 0, direction: 2, tileId: 0 },
          },
        ],
      },
      {
        name: "Action event",
        x: 3,
        y: 2,
        pages: [
          {
            conditions: {
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
            },
            priorityType: 1,
            trigger: 0,
            list: [
              { code: 121, parameters: [1, 1, 0] },
              { code: 0, parameters: [] },
            ],
            image: { characterName: "Actor1", characterIndex: 0, direction: 2, tileId: 0 },
          },
        ],
      },
      {
        name: "Empty event",
        x: 4,
        y: 3,
        pages: [
          {
            conditions: {
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
            },
            priorityType: 1,
            trigger: 0,
            list: [{ code: 0, parameters: [] }],
            image: { characterName: "", characterIndex: 0, direction: 2, tileId: 0 },
          },
        ],
      },
    ],
  },
};

export const plugins = [
  {
    name: "Credits",
    status: true,
    description: "",
    parameters: {
      "Command Name": "致谢",
      Portrait: "立绘",
      Sound: "合成物品",
      Columns: "3",
      Lines: '["第一行"]',
    },
  },
  { name: "Unused", status: false, description: "", parameters: { Label: "关闭" } },
];

// The header of the Credits plugin: Portrait is a file, the rest is untyped. Sound names a file in
// audio/se/ without saying so, as older plugins do.
const creditsPlugin = `/*:
 * @param Command Name
 * @default Credits
 *
 * @param Portrait
 * @type file
 * @dir img/pictures/
 */`;

export function spriteColor(index: number, direction: number): number[] {
  return [40 + index * 25, 40 + ((direction - 2) / 2) * 55, 180, 255];
}
export function spriteSheet(big: boolean) {
  const frameWidth = big ? 64 : 48,
    frameHeight = big ? 96 : 48;
  return png(big ? 192 : 576, 384, (x, y) =>
    spriteColor(
      big ? 0 : Math.floor(x / (frameWidth * 3)) + Math.floor(y / (frameHeight * 4)) * 4,
      (Math.floor(y / frameHeight) % 4) * 2 + 2,
    ),
  );
}

// Writes a minimal game, optionally inside a www/ folder like NW.js deployments.
export async function fixture(root: string, engine: Engine = "MV", wrapped = false) {
  const webRoot = wrapped ? path.join(root, "www") : root;
  await mkdir(path.join(webRoot, "img", "characters"), { recursive: true });
  await writeFile(path.join(webRoot, "img", "characters", "People1.png"), spriteSheet(false));
  await writeFile(path.join(webRoot, "img", "characters", "$Big.png"), spriteSheet(true));
  await mkdir(path.join(webRoot, "audio", "se"), { recursive: true });
  await writeFile(path.join(webRoot, "audio", "se", "合成物品.ogg"), "");
  const core = engine === "MV" ? "rpg_core.js" : "rmmz_core.js";
  await mkdir(path.join(webRoot, "js"), { recursive: true });
  await mkdir(path.join(webRoot, "data"), { recursive: true });
  await writeFile(
    path.join(webRoot, "index.html"),
    `<!doctype html><html><body><h1>Fixture Adventure</h1><p>Press F8</p><script>window.__fixtureEngine=${JSON.stringify(engine)};</script><script src="js/${core}"></script></body></html>`,
  );
  await writeFile(path.join(webRoot, "js", core), coreScript);
  await mkdir(path.join(webRoot, "js", "plugins"));
  await writeFile(
    path.join(webRoot, "js", "plugins.js"),
    `// Generated by RPG Maker.\nvar $plugins =\n${JSON.stringify(plugins, null, 0)};\n`,
  );
  await writeFile(path.join(webRoot, "js", "plugins", "Credits.js"), creditsPlugin);
  for (const [file, value] of Object.entries(data))
    await writeFile(path.join(webRoot, "data", file), JSON.stringify(value));
  return webRoot;
}

let bundledRuntime: Promise<string> | undefined;
function runtimeCode() {
  bundledRuntime ??= buildScript("runtime.js");
  return bundledRuntime;
}

// Loads the built runtime against a fake engine where every character is 10px wide at the
// default font size of 28 and lines are 36px high.
export async function loadRuntime(engine: "MV" | "MZ", extra: Record<string, unknown> = {}) {
  const dummy: any = new Proxy(function () {}, { get: () => dummy, apply: () => dummy });
  const keyListeners: ((event: unknown) => void)[] = [];
  // Panel elements by id keep what the runtime sets on them, such as onclick and textContent.
  const elements: Record<string, any> = {};
  const element = (): any => {
    const props: Record<PropertyKey, unknown> = {};
    return new Proxy(props, { get: (target, key) => (key in target ? target[key] : dummy) });
  };
  const shadow = {
    innerHTML: "",
    querySelector: () => (elements.panel ??= element()),
    getElementById: (id: string) => (elements[id] ??= element()),
  };
  const document = new Proxy(dummy, {
    get: (_, key) => {
      if (key === "currentScript") return { dataset: { game: "g" } };
      if (key === "createElement")
        return () => Object.assign(element(), { attachShadow: () => shadow });
      if (key === "addEventListener")
        return (type: string, listener: (event: unknown) => void) => {
          if (type === "keydown") keyListeners.push(listener);
        };
      return dummy;
    },
  });
  const press = (code: string) => {
    const event = { code, repeat: false, preventDefault() {}, stopImmediatePropagation() {} };
    for (const listener of keyListeners) listener(event);
  };
  class Window {
    contents = { width: 400, height: 72, fontSize: 28 };
    _wordWrap?: boolean;
    _rpgtlFontSize?: number;
    _textState?: { text?: string } | null;
    textWidth(text: string) {
      return (text.length * 10 * this.contents.fontSize) / 28;
    }
    resetFontSettings() {
      this.contents.fontSize = 28;
    }
    makeFontBigger() {
      if (this.contents.fontSize <= 96) this.contents.fontSize += 12;
    }
    makeFontSmaller() {
      if (this.contents.fontSize >= 24) this.contents.fontSize -= 12;
    }
    lineHeight() {
      return 36;
    }
    // MV gives each line its font plus 8 pixels, MZ the space lineHeight() leaves above the font.
    calcTextHeight(state: { text: string; index: number }) {
      const line = state.text.slice(state.index).split("\n")[0]!;
      const fontSize = this.contents.fontSize;
      let largest = fontSize;
      for (const [code] of line.matchAll(new RegExp(`${String.fromCharCode(27)}[{}]`, "g"))) {
        if (code === "\x1b{") this.makeFontBigger();
        else this.makeFontSmaller();
        largest = Math.max(largest, this.contents.fontSize);
      }
      this.contents.fontSize = fontSize;
      return largest + (engine === "MV" ? 8 : this.lineHeight() - 28);
    }
    needsNewPage(state: { index: number; text: string; y: number; height: number }) {
      return state.index < state.text.length && state.y + state.height > this.contents.height;
    }
    convertEscapeCharacters(text: string) {
      return text.replace(/\\/g, "\x1b");
    }
  }
  class Message extends Window {
    // Four rows, as in both engines.
    override contents = { width: 400, height: 144, fontSize: 28 };
    face = false;
    isTriggered() {
      return false;
    }
    newPage(state: { x: number; y: number; startX?: number; startY?: number }) {
      state.x = 0;
      state.y = 0;
      if (state.startX !== undefined) state.startX = 0;
      if (state.startY !== undefined) state.startY = 0;
    }
    newLineX(state?: { rtl: boolean }) {
      if (engine === "MZ") expect(state).toEqual({ rtl: false });
      return this.face ? 168 : 0;
    }
  }
  class Scroll extends Window {
    // MZ creates scrolling text with an empty rectangle and sizes it when a message starts.
    override contents = { width: engine === "MZ" ? 0 : 400, height: 1, fontSize: 28 };
    contentsWidth() {
      return 400;
    }
  }
  class Help extends Window {
    textPadding() {
      return 10;
    }
    baseTextRect() {
      return engine === "MZ" ? { x: 10, width: this.contents.width - 20 } : undefined;
    }
  }
  const win: any = {
    SceneManager: { run() {} },
    addEventListener() {},
    StorageManager: {},
    Game_Player: { prototype: {} },
    Window_Message: Message,
    Window_ScrollText: Scroll,
    Window_Help: Help,
    ...extra,
  };
  const code = await runtimeCode();
  new Function("window", "document", "setInterval", code)(win, document, () => 0);
  win.SceneManager.run();
  const click = (id: string) => elements[id]!.onclick();
  return {
    message: new Message(),
    scroll: new Scroll(),
    help: new Help(),
    Message,
    press,
    click,
    elements,
  };
}

export const imageFixtureKey = "0123456789abcdef0123456789abcdef";

export function readerLine(
  text: string,
  box: [number, number, number, number] = [100, 100, 400, 130],
  score = 0.99,
) {
  const polygon: [number, number][] = [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[2], box[3]],
    [box[0], box[3]],
  ];
  return { text, score, contrast: 255, box, polygon };
}

const blankPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/** An answer shaped like the image reader's /prepare: a PNG that depends on the lines, and a description per block. */
function preparedAnswer(
  body: { lines: ReturnType<typeof readerLine>[]; blocks: number[][] },
  bold = true,
) {
  return {
    erased: Buffer.concat([blankPng, Buffer.from(JSON.stringify(body.lines))]).toString("base64"),
    blocks: body.blocks.map((block, group) => {
      const boxes = block.map((index) => body.lines[index]!.box);
      const area = [
        Math.min(...boxes.map((box) => box[0])),
        Math.min(...boxes.map((box) => box[1])),
        Math.max(...boxes.map((box) => box[2])),
        Math.max(...boxes.map((box) => box[3])),
      ];
      return {
        polygons: block.map((index) => body.lines[index]!.polygon),
        area,
        lineHeight: Math.max(...boxes.map((box) => box[3] - box[1])),
        space: [area[0]! - 20, area[1]! - 20, area[2]! + 20, area[3]! + 20],
        fill: "#ffffff",
        outline: null,
        stroke: 0,
        weight: 0.12,
        bold,
        align: "centre",
        group,
      };
    }),
  };
}

/**
 * Saves read results for `reads` in the state folder as image reading on the Effect server would,
 * each image's blocks prepared by `preparedAnswer` with its erased background beside them.
 */
export async function writeImageReads(
  stateDir: string,
  id: string,
  reads: Record<string, { file: string; lines: ReturnType<typeof readerLine>[] }>,
  bold = true,
) {
  const images: Record<string, object> = {};
  const files = gameFiles(id);
  await mkdir(path.join(stateDir, files.erasedImages), { recursive: true });
  for (const [image, { file, lines }] of Object.entries(reads)) {
    const result = {
      file,
      sha256: "",
      width: 1120,
      height: 630,
      lines: lines.map((line) => ({ ...line, reader: "paddle" as const })),
      includeFaint: false,
      contrastVersion: 2,
      readVersion: 4,
      preparedVersion: 5,
    };
    const blocks = imageBlocks(result);
    const answer = preparedAnswer({ lines, blocks }, bold);
    const erased = Buffer.from(answer.erased, "base64");
    const name = erasedName(erased);
    await writeFile(path.join(stateDir, files.erasedImages, name), erased);
    images[image] = {
      ...result,
      erased: name,
      blocks: answer.blocks.map((block, index) => ({ ...block, lines: blocks[index], grow: 4 })),
    };
  }
  await writeFile(path.join(stateDir, files.imageResults), JSON.stringify({ version: 1, images }));
}

/** System.json as RPGTL serves it with the translations of `entries`, for the runtime to read. */
export function appliedSystem(entries: Entry[]): Record<string, any> {
  const applied = Result.getOrThrow(
    applyTranslations("System.json", GameFile.System({ data: {} }), entries),
  );
  return GameFile.$is("System")(applied) ? applied.data : {};
}
