import { assert, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import {
  collectClues,
  extractPlugins,
  fileOf,
  newEntry,
  nonTextParameters,
  pathOf,
  reuseKeys,
} from "../../index.ts";
import { extractFrom } from "../../testUtils/gameFiles.ts";

it("an entry's id is the start of the SHA-256 of its file, path and source", () => {
  const entry = newEntry({ _tag: "EventName", map: 1, event: 1 }, "客人1号");
  const expected = createHash("sha256")
    .update(JSON.stringify(["Map001.json", ["events", "1", "name"], "客人1号"]))
    .digest("hex")
    .slice(0, 24);
  assert.strictEqual(entry.id, expected);
});

it("sound names stay hidden and event, switch and variable names need CJK text", () => {
  const map = {
    displayName: "大厅",
    bgm: { name: "混乱", volume: 90, pitch: 100, pan: 0 },
    events: [
      null,
      { id: 1, name: "客人1号", pages: [] },
      { id: 2, name: "EV001", pages: [] },
      { id: 3, name: "npc", pages: [] },
    ],
  };
  assert.deepStrictEqual(
    extractFrom("Map001.json", map).map((entry) => [pathOf(entry.location), entry.source]),
    [
      [["events", "1", "name"], "客人1号"],
      [["displayName"], "大厅"],
    ],
  );
  const system = {
    switches: ["", "门开了", ""],
    variables: ["", "", "好感度"],
    titleBgm: { name: "标题", volume: 90, pitch: 100, pan: 0 },
  };
  assert.deepStrictEqual(
    extractFrom("System.json", system).map((entry) => [pathOf(entry.location), entry.source]),
    [
      [["switches", "1"], "门开了"],
      [["variables", "2"], "好感度"],
    ],
  );
});

it("MZ plugin commands and variable text in scripts are extracted", () => {
  const list = [
    { code: 357, parameters: ["Pic", "show", "显示", { text: "生命值", size: "红" }] },
    {
      code: 357,
      parameters: ["Quest", "set", "", { Detail: '{"Title":"任务","Icon":"图"}' }],
    },
    { code: 355, parameters: ['$gameVariables.setValue(5, "人类"); show("图片")'] },
    { code: 655, parameters: ["case 1: $gameVariables.setValue(a,'猫\\'娘');break;"] },
    { code: 111, parameters: [12, '$gameVariables.value(5) == "人类"'] },
  ];
  const entries = extractFrom("CommonEvents.json", [null, { id: 1, list }], {
    nonText: (plugin) => (plugin === "Pic" ? new Set(["size"]) : new Set(["Icon"])),
    fileNames: new Set(),
  });
  assert.deepStrictEqual(
    entries.map((entry) => [pathOf(entry.location).slice(3), entry.source]),
    [
      [["parameters", "3", "text"], "生命值"],
      [["parameters", "3", "Detail", "Title"], "任务"],
      [["parameters", "0", "variableText", "0"], "人类"],
      [["parameters", "0", "variableText", "0"], "猫'娘"],
      [["parameters", "1", "variableText", "0"], "人类"],
    ],
  );
});

it("note tags are extracted when they hold text codes, line breaks or sentences", () => {
  const note = [
    "<sideview battler: 蓝铃菇>",
    "<AddInfoWindowP:\\C[4]品级      \\C[0]普通>",
    "<AddInfoWindowA:15    \\I[95]>",
    "<BookText:河边住着一只老乌龟。\n它从不说话>",
    "<BookCategory:动物>",
    "<Hint:据说它知道宝藏在哪里！>",
    "<Portrait:乌龟\n>",
    "<Elements:火、水>",
    '<Script>if (a < b ? "低" : "高")\nif (x > 1)</Script>',
  ].join("\n");
  assert.deepStrictEqual(
    extractFrom("Armors.json", [null, { id: 1, name: "", note }]).map((e) => [
      pathOf(e.location),
      e.source,
    ]),
    [
      [["1", "note", "noteText", "1"], "\\C[4]品级      \\C[0]普通"],
      [["1", "note", "noteText", "3"], "河边住着一只老乌龟。\n它从不说话"],
      [["1", "note", "noteText", "5"], "据说它知道宝藏在哪里！"],
    ],
  );
});

it("plugin parameters give their Chinese text, but not disabled plugins, files or marked values", () => {
  const plugins = [
    {
      name: "Credits",
      status: true,
      parameters: {
        "Command Name": "致谢",
        Lines: '["第一行"]',
        Portrait: "立绘",
        Sound: "se/合成物品",
        Columns: "2",
      },
    },
    { name: "Unused", status: false, parameters: { Text: "不用" } },
    null,
  ];
  const entries = extractPlugins(plugins, {
    nonText: () => new Set(["Portrait"]),
    fileNames: new Set(["se/合成物品"]),
  });
  assert.deepStrictEqual(
    entries.map((entry) => [fileOf(entry.location), pathOf(entry.location), entry.source]),
    [
      ["plugins.js", ["Credits", "Command Name"], "致谢"],
      ["plugins.js", ["Credits", "Lines", "0"], "第一行"],
    ],
  );
});

it("plugin headers mark files, numbers and choices as not text", () => {
  const header = `/*:
 * @param Title
 * @desc Shown on the title screen.
 *
 * @param Picture
 * @dir img/pictures/
 * @require 1
 *
 * @param Speed
 * @type number
 *
 * @param Note
 * @type note
 */
/*:ja
 * @param Mode
 * @type select
 * @option 一
 */`;
  assert.deepStrictEqual([...nonTextParameters(header)], ["Picture", "Speed", "Mode"]);
});

it("plugin headers read struct fields and command arguments, and lists hold text", () => {
  const header = `/*:
@param Quests
@type struct<Quest>[]

@param Sound
@type file[]
@dir audio/se/

@command show
@arg text
@type multiline_string

@arg size
@type number
*/
/*~struct~Quest:
@param Title
@type string

@param Icon
@type number
*/`;
  assert.deepStrictEqual([...nonTextParameters(header)], ["Sound", "size", "Icon"]);
});

const picture = (id: number, filename: string) => ({ code: 231, parameters: [id, filename] });
const line = () => [
  { code: 101, parameters: ["", 0, 0, 2] },
  { code: 401, parameters: ["本小姐来了"] },
];

it("dialogue pictures identify speakers until replaced or erased, and separate repeated lines", () => {
  const entries = extractFrom("CommonEvents.json", [
    {
      list: [
        picture(1, "(对话框)藤原·美咲13"),
        ...line(),
        picture(1, "(对话框特殊)二阶堂·千秋5"),
        ...line(),
        picture(2, "背景1"),
        ...line(),
        picture(2, "(对话框)藤原·雄一郎9"),
        ...line(),
        { code: 235, parameters: [2] },
        ...line(),
        picture(1, "背景2"),
        ...line(),
        picture(1, "(对话框)藤原·美咲13"),
        { code: 111, parameters: [0, 1, 0] },
        ...line(),
      ],
    },
  ]);
  assert.deepStrictEqual(
    entries.map((entry) => entry.speaker),
    ["藤原·美咲", "二阶堂·千秋", "二阶堂·千秋", undefined, "二阶堂·千秋", undefined, undefined],
  );
  const [first, second] = entries;
  assert.isDefined(first);
  assert.isDefined(second);
  const key = reuseKeys(entries);
  assert.notStrictEqual(key(first), key(second));
  assert.deepStrictEqual(
    collectClues(entries, ["藤原·美咲", "二阶堂·千秋"], "chinese").get("藤原·美咲"),
    {
      she: 1,
      he: 0,
    },
  );
});

it("text written only in halfwidth katakana is extracted", () => {
  const map = { displayName: "", events: [null, { id: 1, name: "ﾎﾟｰｼｮﾝ", pages: [] }] };
  assert.deepStrictEqual(
    extractFrom("Map001.json", map).map((entry) => entry.source),
    ["ﾎﾟｰｼｮﾝ"],
  );
});
