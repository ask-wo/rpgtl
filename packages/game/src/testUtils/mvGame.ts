import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { spriteSheet } from "./fixture.ts";
import { png } from "./png.ts";

// An artificial MV game around the real engine: rpgtkoolmv/corescript (MIT) at the commit
// packages/game/package.json pins, with made-up data, blank images and made-up plugins.
const require = createRequire(import.meta.url);
const corescript = path.dirname(require.resolve("rpgmaker-mv-corescript/package.json"));
const engineScripts = [
  "rpg_core",
  "rpg_managers",
  "rpg_objects",
  "rpg_scenes",
  "rpg_sprites",
  "rpg_windows",
];
const libs = [
  "pixi.js",
  "pixi-tilemap.js",
  "pixi-picture.js",
  "fpsmeter.js",
  "lz-string.js",
  "iphone-inline-video.browser.js",
];

const indexHtml = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <link rel="stylesheet" type="text/css" href="fonts/gamefont.css">
    <title>Fixture Adventure</title>
  </head>
  <body style="background-color: black">
${[
  ...libs.map((lib) => `libs/${lib}`),
  ...engineScripts.map((name) => `${name}.js`),
  "plugins.js",
  "main.js",
]
  .map((script) => `    <script type="text/javascript" src="js/${script}"></script>`)
  .join("\n")}
  </body>
</html>
`;

const gameFont = `@font-face {
  font-family: GameFont;
  src: url("noto-sans-latin-400-normal.woff2");
}
`;

// The corescript's build joins each script's sources in the order its <name>.json lists them.
async function engineScript(name: string) {
  const order: string[] = JSON.parse(await readFile(path.join(corescript, `${name}.json`), "utf8"));
  const parts = await Promise.all(
    order.map((file) => readFile(path.join(corescript, file), "utf8")),
  );
  return parts.join("\n");
}

// Made-up plugins that patch the engine the way common plugins do.
const pluginFiles: Record<string, string> = {
  // Like YEP_CoreEngine: a bigger screen, a smaller font and shorter lines.
  "FixtureCore.js": `/*:
 * @plugindesc Changes the screen size, font size and line height.
 * @param Screen Width
 * @type number
 * @default 816
 *
 * @param Screen Height
 * @type number
 * @default 624
 *
 * @param Font Size
 * @type number
 * @default 28
 *
 * @param Line Height
 * @type number
 * @default 36
 */
(function () {
  var parameters = PluginManager.parameters("FixtureCore");
  var width = Number(parameters["Screen Width"]);
  var height = Number(parameters["Screen Height"]);
  SceneManager._screenWidth = width;
  SceneManager._screenHeight = height;
  SceneManager._boxWidth = width;
  SceneManager._boxHeight = height;
  Window_Base.prototype.standardFontSize = function () {
    return Number(parameters["Font Size"]);
  };
  Window_Base.prototype.lineHeight = function () {
    return Number(parameters["Line Height"]);
  };
})();
`,
  // Like message plugins: fewer rows and an escape code of its own, \\AN[n] for an actor's nickname.
  "FixtureMessage.js": `/*:
 * @plugindesc Message rows and the \\\\AN[n] escape code.
 * @param Message Rows
 * @type number
 * @default 4
 */
(function () {
  var rows = Number(PluginManager.parameters("FixtureMessage")["Message Rows"]);
  Window_Message.prototype.numVisibleRows = function () {
    return rows;
  };
  var convert = Window_Base.prototype.convertEscapeCharacters;
  Window_Base.prototype.convertEscapeCharacters = function (text) {
    text = text.replace(/\\\\AN\\[(\\d+)\\]/gi, function (_, id) {
      var actor = $gameActors.actor(Number(id));
      return actor ? actor.nickname() : "";
    });
    return convert.call(this, text);
  };
})();
`,
  // A title command that opens a scene with lines from its parameters.
  "Credits.js": `/*:
 * @plugindesc Adds a credits command to the title screen.
 * @param Command Name
 * @default Credits
 *
 * @param Lines
 * @type string[]
 * @default []
 */
(function () {
  var parameters = PluginManager.parameters("Credits");
  var lines = JSON.parse(parameters["Lines"] || "[]");

  var makeCommandList = Window_TitleCommand.prototype.makeCommandList;
  Window_TitleCommand.prototype.makeCommandList = function () {
    makeCommandList.call(this);
    this.addCommand(parameters["Command Name"], "credits");
  };
  var createCommandWindow = Scene_Title.prototype.createCommandWindow;
  Scene_Title.prototype.createCommandWindow = function () {
    createCommandWindow.call(this);
    this._commandWindow.setHandler("credits", function () {
      SceneManager.push(Scene_Credits);
    });
  };

  function Scene_Credits() {
    this.initialize.apply(this, arguments);
  }
  Scene_Credits.prototype = Object.create(Scene_MenuBase.prototype);
  Scene_Credits.prototype.constructor = Scene_Credits;
  Scene_Credits.prototype.create = function () {
    Scene_MenuBase.prototype.create.call(this);
    this._creditsWindow = new Window_Help(lines.length);
    this._creditsWindow.setText(lines.join("\\n"));
    this.addWindow(this._creditsWindow);
  };
  Scene_Credits.prototype.update = function () {
    Scene_MenuBase.prototype.update.call(this);
    if (Input.isTriggered("ok") || Input.isTriggered("cancel")) this.popScene();
  };
  window.Scene_Credits = Scene_Credits;
})();
`,
};

const plugins = [
  {
    name: "FixtureCore",
    status: true,
    description: "Changes the screen size, font size and line height.",
    parameters: {
      "Screen Width": "960",
      "Screen Height": "540",
      "Font Size": "22",
      "Line Height": "30",
    },
  },
  {
    name: "FixtureMessage",
    status: true,
    description: "Message rows and the \\AN[n] escape code.",
    parameters: { "Message Rows": "3" },
  },
  {
    name: "Credits",
    status: true,
    description: "Adds a credits command to the title screen.",
    parameters: { "Command Name": "致谢", Lines: '["感谢你的游玩。","制作：测试小组"]' },
  },
];

const audio = { name: "", pan: 0, pitch: 100, volume: 90 };

const conditions = (overrides: Record<string, unknown> = {}) => ({
  actorId: 1,
  actorValid: false,
  itemId: 1,
  itemValid: false,
  selfSwitchCh: "A",
  selfSwitchValid: false,
  switch1Id: 1,
  switch1Valid: false,
  switch2Id: 1,
  switch2Valid: false,
  variableId: 1,
  variableValid: false,
  variableValue: 0,
  ...overrides,
});

type Command = { code: number; indent?: number; parameters: unknown[] };

const page = (
  list: Command[],
  {
    trigger = 0,
    characterName = "",
    characterIndex = 0,
    direction = 2,
    tileId = 0,
    ...overrides
  }: Record<string, any> = {},
) => ({
  conditions: conditions(),
  directionFix: false,
  image: { characterIndex, characterName, direction, pattern: 1, tileId },
  list: [
    ...list.map((command) => ({ indent: 0, ...command })),
    { code: 0, indent: 0, parameters: [] },
  ],
  moveFrequency: 3,
  moveRoute: {
    list: [{ code: 0, parameters: [] }],
    repeat: true,
    skippable: false,
    wait: false,
  },
  moveSpeed: 3,
  moveType: 0,
  priorityType: 1,
  stepAnime: false,
  through: false,
  trigger,
  walkAnime: true,
  ...overrides,
});

const event = (id: number, name: string, x: number, y: number, pages: unknown[]) => ({
  id,
  name,
  note: "",
  pages,
  x,
  y,
});

// A map whose layer 0 has floor (tile 1) inside a wall ring (tile 2) from (left, top) to
// (right, bottom), and tile 3 on layer 2 at `marked`.
function map(
  displayName: string,
  width: number,
  height: number,
  [left, top, right, bottom]: [number, number, number, number],
  marked: number[],
  events: unknown[],
) {
  const data = Array.from({ length: 6 * width * height }, (_, index) => {
    const x = index % width;
    const y = Math.floor(index / width) % height;
    const z = Math.floor(index / (width * height));
    if (z === 2 && x === marked[0] && y === marked[1]) return 3;
    if (z !== 0 || x < left || x > right || y < top || y > bottom) return 0;
    return x === left || x === right || y === top || y === bottom ? 2 : 1;
  });
  return {
    autoplayBgm: false,
    autoplayBgs: false,
    battleback1Name: "",
    battleback2Name: "",
    bgm: audio,
    bgs: audio,
    data,
    disableDashing: false,
    displayName,
    encounterList: [],
    encounterStep: 30,
    events: [null, ...events],
    height,
    note: "",
    parallaxLoopX: false,
    parallaxLoopY: false,
    parallaxName: "",
    parallaxShow: true,
    parallaxSx: 0,
    parallaxSy: 0,
    scrollType: 0,
    specifyBattleback: false,
    tilesetId: 1,
    width,
  };
}

const forestEvents = [
  event(1, "客人1号", 2, 2, [
    page(
      [
        { code: 101, parameters: ["", 0, 0, 2] },
        { code: 401, parameters: ["Welcome!"] },
        { code: 401, parameters: ["Stay a while."] },
        { code: 102, parameters: [["Yes", "No"], 1, 0, 2, 0] },
        { code: 402, parameters: [0, "Yes"] },
        { code: 121, indent: 1, parameters: [1, 1, 0] },
        { code: 0, indent: 1, parameters: [] },
        { code: 402, parameters: [1, "No"] },
        { code: 122, indent: 1, parameters: [1, 1, 0, 0, 1] },
        { code: 0, indent: 1, parameters: [] },
        { code: 404, parameters: [] },
        { code: 111, parameters: [0, 1, 0] },
        { code: 121, indent: 1, parameters: [1, 1, 0] },
        { code: 0, indent: 1, parameters: [] },
        { code: 411, parameters: [] },
        { code: 122, indent: 1, parameters: [1, 1, 0, 0, 2] },
        { code: 0, indent: 1, parameters: [] },
        { code: 412, parameters: [] },
        { code: 117, parameters: [1] },
      ],
      { characterName: "People1", characterIndex: 2 },
    ),
    {
      ...page([{ code: 123, parameters: ["A", 0] }], {
        characterName: "People1",
        characterIndex: 7,
        direction: 6,
      }),
      conditions: conditions({ switch1Valid: true, switch1Id: 1 }),
    },
    {
      ...page([], { characterName: "$Big", direction: 8 }),
      conditions: conditions({ selfSwitchValid: true, selfSwitchCh: "A" }),
    },
  ]),
  event(2, "EV001", 3, 2, [
    page(
      [
        { code: 101, parameters: ["", 0, 0, 2] },
        { code: 401, parameters: ["Ouch, \\AN[1]."] },
      ],
      {
        trigger: 1,
        characterName: "People1",
        characterIndex: 6,
        direction: 6,
      },
    ),
  ]),
  event(3, "巡逻员", 4, 2, [
    page(
      [
        { code: 101, parameters: ["", 0, 0, 2] },
        { code: 401, parameters: ["Halt!"] },
      ],
      {
        trigger: 2,
        characterName: "$Big",
        direction: 4,
      },
    ),
  ]),
  // Runs once when the game starts, then turns itself into an action button event.
  event(4, "Introduction", 5, 2, [
    page(
      [
        { code: 101, parameters: ["", 0, 0, 2] },
        { code: 401, parameters: ["你醒了。这里是森林。"] },
        { code: 123, parameters: ["A", 0] },
      ],
      { trigger: 3, characterName: "Actor1", characterIndex: 2 },
    ),
    {
      ...page([], { characterName: "Actor1", characterIndex: 2 }),
      conditions: conditions({ selfSwitchValid: true, selfSwitchCh: "A" }),
    },
  ]),
  event(5, "Watcher", 6, 2, [page([{ code: 230, parameters: [60] }], { trigger: 4 })]),
  event(6, "Finished", 7, 4, [page([], { tileId: 1 })]),
  event(7, "Unavailable", 8, 4, [
    { ...page([]), conditions: conditions({ switch1Valid: true, switch1Id: 2 }) },
  ]),
];

const fieldEvents = [
  event(1, "Switch event", 1, 1, [
    {
      ...page([{ code: 121, parameters: [1, 1, 0] }]),
      conditions: conditions({ switch1Valid: true, switch1Id: 1 }),
    },
  ]),
  event(2, "Action event", 3, 2, [
    page([{ code: 121, parameters: [1, 1, 0] }], { characterName: "Actor1" }),
  ]),
  event(3, "Empty event", 4, 3, [page([])]),
];

const params = (base: number) =>
  Array.from({ length: 100 }, (_, level) => base + level * Math.ceil(base / 10));

const item = {
  animationId: 0,
  consumable: true,
  damage: { critical: false, elementId: 0, formula: "0", type: 0, variance: 20 },
  description: "Recover \\V[1] HP.",
  effects: [{ code: 11, dataId: 0, value1: 0, value2: 100 }],
  hitType: 0,
  iconIndex: 176,
  id: 1,
  itypeId: 1,
  name: "Potion",
  note: "",
  occasion: 0,
  price: 50,
  repeats: 1,
  scope: 7,
  speed: 0,
  successRate: 100,
  tpGain: 0,
};

const skill = (id: number, name: string, formula: string) => ({
  ...item,
  description: "",
  effects: [],
  iconIndex: 76,
  id,
  message1: `%1 uses ${name}!`,
  message2: "",
  mpCost: 0,
  name,
  requiredWtypeId1: 0,
  requiredWtypeId2: 0,
  scope: id === 1 ? 1 : 11,
  stypeId: 0,
  tpCost: 0,
  damage: { ...item.damage, formula, type: id === 1 ? 1 : 0 },
});

const vehicle = (characterIndex: number, x: number, y: number) => ({
  bgm: audio,
  characterIndex,
  characterName: "Vehicle",
  startMapId: 1,
  startX: x,
  startY: y,
});

const data = {
  "Actors.json": [
    null,
    {
      battlerName: "",
      characterIndex: 0,
      characterName: "Actor1",
      classId: 1,
      equips: [0, 0, 0, 0, 0],
      faceIndex: 0,
      faceName: "",
      id: 1,
      initialLevel: 1,
      maxLevel: 99,
      name: "Hero",
      nickname: "Traveler",
      note: "<plugin:do not touch>",
      profile: "A brave explorer",
      traits: [],
    },
  ],
  "Animations.json": [null],
  "Armors.json": [null],
  "Classes.json": [
    null,
    {
      expParams: [30, 20, 30, 30],
      id: 1,
      learnings: [],
      name: "Adventurer",
      note: "",
      params: [500, 50, 20, 20, 20, 20, 20, 20].map(params),
      traits: [
        { code: 23, dataId: 0, value: 1 },
        { code: 22, dataId: 0, value: 0.95 },
        { code: 41, dataId: 1, value: 1 },
        { code: 51, dataId: 1, value: 1 },
        { code: 52, dataId: 1, value: 1 },
      ],
    },
  ],
  "CommonEvents.json": [
    null,
    {
      id: 1,
      list: [
        { code: 101, indent: 0, parameters: ["", 0, 0, 2] },
        { code: 401, indent: 0, parameters: ["From the common event."] },
        { code: 117, indent: 0, parameters: [2] },
        { code: 0, indent: 0, parameters: [] },
      ],
      name: "Internal event",
      switchId: 1,
      trigger: 0,
    },
    {
      id: 2,
      list: [
        { code: 101, indent: 0, parameters: ["", 0, 0, 2] },
        { code: 401, indent: 0, parameters: ["你好，旅行者。欢迎来到森林。"] },
        { code: 101, indent: 0, parameters: ["", 0, 0, 2] },
        { code: 401, indent: 0, parameters: ["这把剑很重，你要小心。"] },
        { code: 105, indent: 0, parameters: [2, false] },
        { code: 405, indent: 0, parameters: ["Long ago…"] },
        { code: 405, indent: 0, parameters: ["in a far land."] },
        { code: 0, indent: 0, parameters: [] },
      ],
      name: "Chinese dialogue",
      switchId: 1,
      trigger: 0,
    },
  ],
  "Enemies.json": [null],
  "Items.json": [null, item],
  "MapInfos.json": [
    null,
    { expanded: true, id: 1, name: "Forest", order: 1, parentId: 0, scrollX: 0, scrollY: 0 },
    { expanded: false, id: 2, name: "Second Field", order: 2, parentId: 1, scrollX: 0, scrollY: 0 },
  ],
  "Map001.json": map("Fixture Forest", 40, 24, [1, 1, 9, 6], [4, 4], forestEvents),
  "Map002.json": map("Second Field", 8, 7, [1, 1, 6, 5], [3, 3], fieldEvents),
  "Skills.json": [null, skill(1, "Attack", "a.atk * 4 - b.def * 2"), skill(2, "Guard", "0")],
  "States.json": [
    null,
    {
      autoRemovalTiming: 0,
      chanceByDamage: 100,
      iconIndex: 1,
      id: 1,
      maxTurns: 1,
      message1: " has fallen!",
      message2: " is slain!",
      message3: "",
      message4: " revives!",
      minTurns: 1,
      motion: 3,
      name: "Knockout",
      note: "",
      overlay: 0,
      priority: 100,
      releaseByDamage: false,
      removeAtBattleEnd: false,
      removeByDamage: false,
      removeByRestriction: false,
      removeByWalking: false,
      restriction: 4,
      stepsToRemove: 100,
      traits: [],
    },
  ],
  "System.json": {
    airship: vehicle(3, 0, 0),
    armorTypes: ["", "General Armor"],
    attackMotions: [{ type: 0, weaponImageId: 0 }],
    battleBgm: audio,
    battleback1Name: "",
    battleback2Name: "",
    battlerHue: 0,
    battlerName: "",
    boat: vehicle(0, 2, 6),
    currencyUnit: "Gold",
    defeatMe: audio,
    editMapId: 1,
    elements: ["", "Physical"],
    equipTypes: ["", "Weapon", "Shield", "Head", "Body", "Accessory"],
    gameTitle: "Fixture Adventure",
    gameoverMe: audio,
    locale: "en_US",
    magicSkills: [1],
    menuCommands: [true, true, true, true, true, true],
    optDisplayTp: true,
    optDrawTitle: true,
    optExtraExp: false,
    optFloorDeath: false,
    optFollowers: true,
    optSideView: false,
    optSlipDeath: false,
    optTransparent: false,
    partyMembers: [1],
    ship: vehicle(1, 0, 0),
    skillTypes: ["", "Magic"],
    sounds: Array.from({ length: 24 }, () => audio),
    startMapId: 1,
    startX: 5,
    startY: 5,
    switches: ["", "门开了", "Never"],
    terms: {
      basic: ["Level", "Lv", "HP", "HP", "MP", "MP", "TP", "TP", "EXP", "EXP"],
      commands: [
        "Fight",
        "Escape",
        "Attack",
        "Guard",
        "Item",
        "Skill",
        "Equip",
        "Status",
        "Formation",
        "Save",
        "Game End",
        "Options",
        "Weapon",
        "Armor",
        "Key Item",
        "Equip",
        "Optimize",
        "Clear",
        "New Game",
        "Continue",
        null,
        "To Title",
        "Cancel",
        null,
        "Buy",
        "Sell",
      ],
      params: [
        "Max HP",
        "Max MP",
        "Attack",
        "Defense",
        "M.Attack",
        "M.Defense",
        "Agility",
        "Luck",
        "Hit",
        "Evasion",
      ],
      messages: {
        actionFailure: "There was no effect on %1!",
        actorDamage: "%1 took %2 damage!",
        actorDrain: "%1 was drained of %2 %3!",
        actorGain: "%1 gained %2 %3!",
        actorLoss: "%1 lost %2 %3!",
        actorNoDamage: "%1 took no damage!",
        actorNoHit: "Miss! %1 took no damage!",
        actorRecovery: "%1 recovered %2 %3!",
        alwaysDash: "Always Dash",
        bgmVolume: "BGM Volume",
        bgsVolume: "BGS Volume",
        buffAdd: "%1's %2 went up!",
        buffRemove: "%1's %2 returned to normal!",
        commandRemember: "Command Remember",
        counterAttack: "%1 counterattacked!",
        criticalToActor: "A painful blow!!",
        criticalToEnemy: "An excellent hit!!",
        debuffAdd: "%1's %2 went down!",
        defeat: "%1 was defeated.",
        emerge: "%1 emerged!",
        enemyDamage: "%1 took %2 damage!",
        enemyDrain: "%1 was drained of %2 %3!",
        enemyGain: "%1 gained %2 %3!",
        enemyLoss: "%1 lost %2 %3!",
        enemyNoDamage: "%1 took no damage!",
        enemyNoHit: "Miss! %1 took no damage!",
        enemyRecovery: "%1 recovered %2 %3!",
        escapeFailure: "However, it was unable to escape!",
        escapeStart: "%1 has started to escape!",
        evasion: "%1 evaded the attack!",
        expNext: "To Next %1",
        expTotal: "Current %1",
        file: "File",
        levelUp: "%1 is now %2 %3!",
        loadMessage: "Load which file?",
        magicEvasion: "%1 nullified the magic!",
        magicReflection: "%1 reflected the magic!",
        meVolume: "ME Volume",
        obtainExp: "%1 %2 received!",
        obtainGold: "%1\\G found!",
        obtainItem: "%1 found!",
        obtainSkill: "%1 learned!",
        partyName: "%1's Party",
        possession: "Possession",
        preemptive: "%1 got the upper hand!",
        saveMessage: "Save to which file?",
        seVolume: "SE Volume",
        substitute: "%1 protected %2!",
        surprise: "%1 was surprised!",
        useItem: "%1 uses %2!",
        victory: "%1 wins!",
      },
    },
    testBattlers: [],
    testTroopId: 0,
    title1Name: "",
    title2Name: "",
    titleBgm: audio,
    variables: ["", "任务进度", "好感度"],
    versionId: 1,
    victoryMe: audio,
    weaponTypes: ["", "Sword"],
    windowTone: [0, 0, 0, 0],
  },
  "Tilesets.json": [
    null,
    {
      flags: Array.from({ length: 8192 }, (_, tileId) => [0x10, 0, 0x0f, 0x08][tileId] ?? 0),
      id: 1,
      mode: 1,
      name: "Field",
      note: "",
      tilesetNames: ["", "", "", "", "", "Field_B", "", "", ""],
    },
  ],
  "Troops.json": [null],
  "Weapons.json": [null],
};

// The window skin: a dark background, a light frame and cursor, and the 32 text colours that
// Window_Base.textColor reads from the bottom right.
const textColors = [
  [255, 255, 255],
  [32, 160, 214],
  [255, 120, 76],
  [102, 204, 64],
  [153, 204, 255],
  [204, 192, 255],
  [255, 255, 160],
  [128, 128, 128],
  [192, 192, 192],
  [32, 128, 204],
  [255, 56, 16],
  [0, 160, 16],
  [62, 154, 222],
  [160, 152, 255],
  [255, 204, 32],
  [0, 0, 0],
  [132, 170, 255],
  [255, 255, 64],
  [255, 32, 32],
  [32, 32, 64],
  [224, 128, 64],
  [240, 192, 64],
  [64, 128, 192],
  [64, 192, 240],
  [128, 255, 128],
  [192, 128, 128],
  [128, 128, 255],
  [255, 128, 255],
  [0, 160, 64],
  [0, 224, 96],
  [160, 96, 224],
  [192, 128, 255],
];
const windowSkin = png(192, 192, (x, y) => {
  if (x < 96) return y < 96 ? [16, 24, 64, 255] : [0, 0, 0, 0];
  if (y < 96) {
    const edge = Math.min(x - 96, 191 - x, y, 95 - y);
    return edge < 4 ? [224, 224, 240, 255] : [0, 0, 0, 0];
  }
  if (y < 144) return x < 144 ? [255, 255, 255, 64] : [0, 0, 0, 0];
  const color = textColors[Math.floor((x - 96) / 12) + Math.floor((y - 144) / 12) * 8]!;
  return [...color, 255];
});

// Tileset sheet B: tile 1 is floor, 2 is wall, 3 a mark on the floor, in 48px tiles.
const tilesetColors = [
  [0, 0, 0, 0],
  [72, 112, 64, 255],
  [120, 120, 136, 255],
  [208, 176, 64, 255],
];
const tilesetB = png(768, 768, (x, y) => {
  const tile = Math.floor(y / 48) * 16 + Math.floor(x / 48);
  const color = tilesetColors[tile] ?? [0, 0, 0, 0];
  const edge = Math.min(x % 48, y % 48) === 0;
  return tile === 3 && Math.abs((x % 48) - 24) + Math.abs((y % 48) - 24) > 12
    ? [0, 0, 0, 0]
    : edge && tile > 0
      ? [0, 0, 0, 96]
      : color;
});

const images: Record<string, Buffer> = {
  "tilesets/Field_B.png": tilesetB,
  "characters/Actor1.png": spriteSheet(false),
  "characters/People1.png": spriteSheet(false),
  "characters/$Big.png": spriteSheet(true),
  "characters/Vehicle.png": spriteSheet(false),
  "system/Window.png": windowSkin,
  "system/IconSet.png": png(512, 512),
  "system/Balloon.png": png(384, 480),
  "system/Shadow1.png": png(48, 48),
  "system/Shadow2.png": png(48, 48),
  "system/Damage.png": png(540, 180),
  "system/States.png": png(96, 96),
  "system/Weapons1.png": png(576, 192),
  "system/Weapons2.png": png(576, 192),
  "system/Weapons3.png": png(576, 192),
  "system/ButtonSet.png": png(240, 48),
  "system/Loading.png": png(48, 48),
};

/** Writes the game into `root`, which is also its web root, and returns `root`. */
export async function mvGame(root: string) {
  const js = path.join(root, "js");
  await mkdir(path.join(js, "plugins"), { recursive: true });
  await writeFile(path.join(root, "index.html"), indexHtml);
  for (const name of engineScripts)
    await writeFile(path.join(js, `${name}.js`), await engineScript(name));
  await cp(path.join(corescript, "js", "libs"), path.join(js, "libs"), { recursive: true });
  await copyFile(path.join(corescript, "js", "main.js"), path.join(js, "main.js"));
  await writeFile(
    path.join(js, "plugins.js"),
    `// Generated by RPG Maker.\nvar $plugins =\n${JSON.stringify(plugins)};\n`,
  );
  for (const [file, code] of Object.entries(pluginFiles))
    await writeFile(path.join(js, "plugins", file), code);
  await mkdir(path.join(root, "fonts"));
  await writeFile(path.join(root, "fonts", "gamefont.css"), gameFont);
  await copyFile(
    require.resolve("@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff2"),
    path.join(root, "fonts", "noto-sans-latin-400-normal.woff2"),
  );
  await mkdir(path.join(root, "data"));
  for (const [file, value] of Object.entries(data))
    await writeFile(path.join(root, "data", file), JSON.stringify(value));
  for (const [file, bytes] of Object.entries(images)) {
    await mkdir(path.dirname(path.join(root, "img", file)), { recursive: true });
    await writeFile(path.join(root, "img", file), bytes);
  }
  return root;
}
