import { assert, it } from "@effect/vitest";
import type { Entry, Location } from "@rpgtl/contracts";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import {
  applyPluginTranslations,
  applyTranslations,
  extractPlugins,
  GameDataChanged,
  messageLayouts,
  translatedImageNames,
} from "./index.ts";
import { extractFrom, readGameFile } from "./testUtils/gameFiles.ts";

const changedFile = (result: Result.Result<unknown, GameDataChanged>) =>
  Result.isFailure(result) ? result.failure.file : undefined;

const applied = (file: string, data: unknown, entries: ReadonlyArray<Entry>) =>
  Result.getOrThrow(applyTranslations(file, readGameFile(file, data), entries)).data;

it("applying a translation checks that the data still holds the source", () => {
  const entry: Entry = {
    id: "a",
    location: { _tag: "RecordField", table: "actors", record: 1, field: "name" },
    source: "勇者",
    translation: { user: "Hero" },
  };
  const translated = applied("Actors.json", [null, { id: 1, name: "勇者" }], [entry]);
  assert.deepStrictEqual(translated, [null, { id: 1, name: "Hero" }]);
  assert.strictEqual(
    changedFile(applyTranslations("Actors.json", readGameFile("Actors.json", translated), [entry])),
    "Actors.json",
  );
});

it("a message's lines become one command holding the translation", () => {
  const list = [
    { code: 101, parameters: ["", 0, 0, 2] },
    { code: 401, parameters: ["第一行"] },
    { code: 401, parameters: ["第二行"] },
    { code: 0, parameters: [] },
  ];
  const data = [null, { id: 1, list }];
  const [entry] = extractFrom("CommonEvents.json", data);
  assert.isDefined(entry);
  assert.strictEqual(entry.source, "第一行\n第二行");
  assert.deepStrictEqual(
    applied("CommonEvents.json", data, [{ ...entry, translation: { user: "One line" } }]),
    [
      null,
      {
        id: 1,
        list: [
          { code: 101, parameters: ["", 0, 0, 2] },
          { code: 401, parameters: ["One line"] },
          { code: 0, parameters: [] },
        ],
      },
    ],
  );
});

it("a message whose command is gone from a shortened list means the data changed", () => {
  const data = [
    null,
    {
      id: 1,
      list: [
        { code: 101, parameters: ["", 0, 0, 2] },
        { code: 401, parameters: ["第一行"] },
        { code: 0, parameters: [] },
      ],
    },
  ];
  const entries = extractFrom("CommonEvents.json", data).map((entry) => ({
    ...entry,
    translation: { user: "One line" },
  }));
  const shortened = [null, { id: 1, list: [{ code: 0, parameters: [] }] }];
  assert.strictEqual(
    changedFile(
      applyTranslations("CommonEvents.json", readGameFile("CommonEvents.json", shortened), entries),
    ),
    "CommonEvents.json",
  );
});

it("plugin settings are translated inside JSON text, and a changed setting means the data changed", () => {
  const plugins = [
    null,
    { name: "Menu", status: true, description: "菜单", parameters: { Items: '["物品","技能"]' } },
  ];
  const entry: Entry = {
    id: "a",
    location: { _tag: "PluginSetting", plugin: "Menu", keys: ["Items", "1"] },
    source: "技能",
    translation: { user: "Skills" },
  };
  assert.deepStrictEqual(Result.getOrThrow(applyPluginTranslations(plugins, [entry])), [
    null,
    { name: "Menu", status: true, description: "菜单", parameters: { Items: '["物品","Skills"]' } },
  ]);
  const changed = [
    null,
    { name: "Menu", status: true, description: "菜单", parameters: { Items: '["物品"]' } },
  ];
  assert.isTrue(Result.isFailure(applyPluginTranslations(changed, [entry])));
});

const menuPlugin = (text: string) => ({ name: "Menu", status: true, parameters: { Title: text } });

it("of two enabled plugins with the same name, the last one's settings are translated", () => {
  const entries = extractPlugins([menuPlugin("旧"), menuPlugin("新")], {
    nonText: () => new Set(),
    fileNames: new Set(),
  }).map((entry) => ({ ...entry, translation: { user: "New" } }));
  assert.deepStrictEqual(
    Result.getOrThrow(applyPluginTranslations([menuPlugin("旧"), menuPlugin("新")], entries)),
    [menuPlugin("旧"), menuPlugin("New")],
  );
});

const systemEntry = (keys: string[], source: string, translation: string): Entry => ({
  id: keys.join("."),
  location: { _tag: "SystemText", keys },
  source,
  translation: translation ? { user: translation } : {},
});

it("translated menu commands mark System.json for the title screen", () => {
  const title = systemEntry(["gameTitle"], "游戏", "Game");
  const system = { gameTitle: "游戏", terms: { commands: ["战斗"] } };
  const titleOnly = applied("System.json", system, [title]);
  assert.isFalse(Predicate.hasProperty(titleOnly, "rpgtlCommandsTranslated"));
  const command = systemEntry(["terms", "commands", "0"], "战斗", "Fight");
  const both = applied("System.json", system, [title, command]);
  assert.isTrue(
    Predicate.hasProperty(both, "rpgtlCommandsTranslated") && both.rpgtlCommandsTranslated,
  );
});

const skillType = (source: string, translation: string): Entry => ({
  id: translation,
  location: { _tag: "SystemText", keys: ["skillTypes", "1"] },
  source,
  translation: translation ? { user: translation } : {},
});

it("images named after translated text are loaded under their translated names", () => {
  // Com_Attack is already a file, and 麻痹 is only part of the Chinese in 雷电麻痹.
  const files = [
    "img/battlecommands/Com_魔法技能.rpgmvp",
    "img/battlecommands/Com_攻击.png",
    "img/battlecommands/Com_Attack.png",
    "img/menus/main/commands/物品.png",
    "img/animations/雷电麻痹.png",
    "audio/se/魔法技能.ogg",
  ];
  const entries = [
    skillType("魔法技能", "Magic"),
    skillType("魔法技能", "Spells"),
    skillType("攻击", "Attack"),
    skillType("物品", "Items"),
    skillType("麻痹", "Paralysis"),
  ];
  assert.deepStrictEqual(translatedImageNames(files, entries), {
    "img/battlecommands/Com_Magic": { file: "Com_魔法技能" },
    "img/battlecommands/Com_Spells": { file: "Com_魔法技能" },
    "img/menus/main/commands/Items": { file: "物品" },
  });
});

const words: Record<string, string> = {
  生命值: "HP",
  任务: 'The "Job"',
  人类: "Human",
  "猫'娘": "Catgirl",
};

const scriptCommands = () => [
  { code: 357, parameters: ["Pic", "show", "显示", { text: "生命值", size: "红" }] },
  {
    code: 357,
    parameters: ["Quest", "set", "", { Detail: '{"Title":"任务","Icon":"图"}' }],
  },
  { code: 355, parameters: ['$gameVariables.setValue(5, "人类"); show("图片")'] },
  { code: 655, parameters: ["case 1: $gameVariables.setValue(a,'猫\\'娘');break;"] },
  { code: 111, parameters: [12, '$gameVariables.value(5) == "人类"'] },
];

it("MZ plugin commands and variable text in scripts are applied", () => {
  const original = scriptCommands();
  const entries = extractFrom("CommonEvents.json", [null, { id: 1, list: original }], {
    nonText: (plugin) => (plugin === "Pic" ? new Set(["size"]) : new Set(["Icon"])),
    fileNames: new Set(),
  }).map((entry) => ({ ...entry, translation: { user: words[entry.source] ?? "" } }));
  const translated = applied("CommonEvents.json", [null, { id: 1, list: original }], entries);
  const parameters = [
    ["Pic", "show", "显示", { text: "HP", size: "红" }],
    ["Quest", "set", "", { Detail: '{"Title":"The \\"Job\\"","Icon":"图"}' }],
    ['$gameVariables.setValue(5, "Human"); show("图片")'],
    ['case 1: $gameVariables.setValue(a,"Catgirl");break;'],
    [12, '$gameVariables.value(5) == "Human"'],
  ];
  assert.deepStrictEqual(translated, [
    null,
    { id: 1, list: original.map((command, i) => ({ ...command, parameters: parameters[i] })) },
  ]);
  const changed = scriptCommands();
  changed[2] = { code: 355, parameters: ['$gameVariables.setValue(5, "魅魔")'] };
  assert.strictEqual(
    changedFile(
      applyTranslations(
        "CommonEvents.json",
        readGameFile("CommonEvents.json", [null, { id: 1, list: changed }]),
        entries,
      ),
    ),
    "CommonEvents.json",
  );
});

it("note tags with text are translated in place; other note tags are left alone", () => {
  const note = [
    "<sideview battler: 蓝铃菇>",
    "<AddInfoWindowP:\\C[4]品级      \\C[0]普通>",
    "<AddInfoWindowA:15    \\I[95]>",
    "<AddInfoWindowP:\\C[4]部位      \\C[0]护肩>",
    "<BookText:河边住着一只老乌龟。\n它从不说话>",
  ].join("\n");
  const armor = { id: 1, name: "", note };
  const translations = [
    "Grade      Common",
    "\\C[4]Slot      \\C[0]Shoulder <L>\nguard",
    "An old turtle lives by the river.\nIt never speaks.",
  ];
  const entries = extractFrom("Armors.json", [null, armor]).map((entry, i) => ({
    ...entry,
    translation: { user: translations[i] ?? "" },
  }));
  assert.deepStrictEqual(applied("Armors.json", [null, armor], entries), [
    null,
    {
      ...armor,
      note: [
        "<sideview battler: 蓝铃菇>",
        "<AddInfoWindowP:Grade      Common>",
        "<AddInfoWindowA:15    \\I[95]>",
        "<AddInfoWindowP:\\C[4]Slot      \\C[0]Shoulder ‹L› guard>",
        "<BookText:An old turtle lives by the river.\nIt never speaks.>",
      ].join("\n"),
    },
  ]);
});

const layoutEntry = (
  source: string,
  translation: string,
  location: Location = {
    _tag: "Message",
    list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
    index: 0,
  },
): Entry => ({
  id: source,
  source,
  translation: translation ? { user: translation } : {},
  location,
});

it("message layouts include only leading-blank, space-padded event messages", () => {
  const padded = "\n        The source text sits inside its picture\n        with a second line.";
  assert.deepStrictEqual(
    messageLayouts([
      layoutEntry(padded, "Picture text"),
      layoutEntry("        no blank row before this", "No leading row"),
      layoutEntry("\n\t tab indented", "Tab indentation"),
      layoutEntry("\n        first line\n    uneven second line", "Uneven indentation"),
      layoutEntry(padded, ""),
      layoutEntry(padded, "Not a list message", {
        _tag: "CommandText",
        list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
        index: 0,
        parameter: 0,
        keys: ["0"],
      }),
    ]),
    {
      "Picture text": {
        top: 1,
        indent: "        ",
        widest: ["The source text sits inside its picture", "with a second line."],
        rows: 2,
      },
    },
  );
});

it("message layouts share the longest lines and lowest row of messages with the same indent", () => {
  const indent = "        ";
  assert.deepStrictEqual(
    messageLayouts([
      layoutEntry(`\n${indent}短`, "Short"),
      layoutEntry(`\n\n${indent}这一行比较长一些\n${indent}第二行\n${indent}第三行`, ""),
      layoutEntry(`\n                    A different frame`, "Other frame"),
    ]),
    {
      Short: { top: 1, indent, widest: ["这一行比较长一些", "第二行", "第三行", "短"], rows: 4 },
      "Other frame": {
        top: 1,
        indent: " ".repeat(20),
        widest: ["A different frame"],
        rows: 1,
      },
    },
  );
});

const indented = (spaces: number, text: string) => `\n${" ".repeat(spaces)}${text}`;

it("message layouts put messages a few spaces off a common indent in its frame", () => {
  const layouts = messageLayouts([
    layoutEntry(indented(34, "第一句话比较长"), ""),
    layoutEntry(indented(34, "第二句\n") + " ".repeat(34) + "第三行", ""),
    layoutEntry(indented(37, "居中"), "Centred"),
    layoutEntry(indented(35, "上一行") + "\n" + " ".repeat(34) + "下一行", "Uneven"),
  ]);
  const frame = { top: 1, indent: " ".repeat(34), rows: 2 };
  assert.deepInclude(layouts.Centred, frame);
  assert.strictEqual(layouts.Centred?.widest[0], "第一句话比较长");
  assert.deepInclude(layouts.Uneven, frame);
});

it("message layouts tell apart the same translation in different frames by its indent", () => {
  const left = `\n${" ".repeat(34)}......`;
  const right = `\n${" ".repeat(51)}......`;
  const layouts = messageLayouts([
    layoutEntry(`\n${" ".repeat(34)}……`, `${left}\n`),
    layoutEntry(`\n${" ".repeat(51)}……`, right),
    layoutEntry(`\n${" ".repeat(34)}……`, "......"),
    layoutEntry(`\n${" ".repeat(51)}……`, "......"),
  ]);
  assert.strictEqual(layouts[left]?.indent, " ".repeat(34));
  assert.strictEqual(layouts[right]?.indent, " ".repeat(51));
  assert.isUndefined(layouts["......"]);
});

it("message layouts keep the frame's 20 longest distinct lines without escape codes", () => {
  const indent = "        ";
  const lines = Array.from({ length: 30 }, (_, i) =>
    layoutEntry(`\n${indent}${"字".repeat(i + 1)}`, i ? "" : "Short"),
  );
  const layouts = messageLayouts([
    ...lines,
    ...lines,
    layoutEntry(`\n${indent}去往\\C[14]米兰德镇\\C[0]`, "Coloured"),
  ]);
  assert.deepStrictEqual(
    layouts.Short?.widest,
    Array.from({ length: 20 }, (_, i) => "字".repeat(30 - i)),
  );
  assert.deepStrictEqual(
    messageLayouts([layoutEntry(`\n${indent}去往\\C[14]米兰德镇\\C[0]`, "Coloured")]).Coloured
      ?.widest,
    ["去往米兰德镇"],
  );
});
