import { assert, it } from "@effect/vitest";
import { type GameContents, missingText, newEntry, textInLogic } from "./index.ts";

const map = {
  events: [
    null,
    {
      name: "宝箱",
      pages: [
        {
          list: [
            { code: 101, parameters: ["头像", 0, 0, 2] },
            { code: 108, parameters: ["注释"] },
            { code: 355, parameters: ['$gameVariables.setValue(1, "人类")'] },
            { code: 111, parameters: [12, '$gameActors.actor(1).name() == "致谢"'] },
          ],
        },
      ],
    },
  ],
};
const contents: GameContents = {
  dataFiles: [
    {
      name: "Items.json",
      data: [
        null,
        { id: 1, note: "掉落率低\n<手动>\n<Category:宝物>" },
        { id: 2, note: "<Help Description>\n一把旧钥匙\n</Help Description>" },
        { id: 3, note: "<提示:它在门后。>\n<BookText:河边住着一只老乌龟。\n它从不说话>" },
      ],
    },
    { name: "Map009.json", data: map },
  ],
  plugins: [
    { name: "Credits", status: true, parameters: { title: "制作", list: '["致谢"]' } },
    { name: "Off", status: false, parameters: { title: "关闭" } },
  ],
  pluginCode: new Map([["Credits", 'if (name === "致谢") show();\n/* "致谢" */']]),
};
const catalog = {
  entries: [
    {
      ...newEntry("System.json", ["terms", "commands", "0"], "致谢"),
      translation: { user: "Credits" },
    },
    {
      ...newEntry("Map009.json", ["events", "1", "pages", "0", "list", "1"], "人类"),
      translation: { user: "Human" },
    },
    {
      ...newEntry("Items.json", ["3", "note", "noteText", "0"], "它在门后。"),
      translation: { user: "It is behind the door." },
    },
    {
      ...newEntry("Items.json", ["3", "note", "noteText", "1"], "河边住着一只老乌龟。\n它从不说话"),
      translation: { user: "An old turtle lives by the river.\nIt never speaks." },
    },
  ],
};

it("Coverage lists text no entry covers, by where it is, file and editor names last, and leaves out a script's own text", () => {
  assert.deepStrictEqual(missingText(contents, ["System.json"], catalog), [
    {
      where: "Items.json note (file not read by RPGTL)",
      shown: true,
      count: 2,
      examples: ["<Category:宝物>", "<Help Description>\n一把旧钥匙\n</Help Description>"],
    },
    {
      where: "Map*.json code 108 parameter 0 (file not read by RPGTL)",
      shown: true,
      count: 1,
      examples: ["注释"],
    },
    // The condition is game logic, which `textInLogic` checks; its text isn't extracted.
    {
      where: "Map*.json code 111 parameter 1 (file not read by RPGTL)",
      shown: true,
      count: 1,
      examples: ['$gameActors.actor(1).name() == "致谢"'],
    },
    { where: "plugins.js Credits", shown: true, count: 1, examples: ["制作"] },
    {
      where: "Items.json note outside tags (file not read by RPGTL)",
      shown: false,
      count: 1,
      examples: ["掉落率低\n<手动>\n"],
    },
    {
      where: "Map*.json code 101 parameter 0 (file not read by RPGTL)",
      shown: false,
      count: 1,
      examples: ["头像"],
    },
    {
      where: "Map*.json name (file not read by RPGTL)",
      shown: false,
      count: 1,
      examples: ["宝箱"],
    },
  ]);
});

it("Logic uses list translated text that scripts and enabled plugins' code compare", () => {
  assert.deepStrictEqual(textInLogic(contents, catalog), [
    {
      where: "Map*.json code 111",
      text: "致谢",
      translation: "Credits",
      line: '$gameActors.actor(1).name() == "致谢"',
    },
    {
      where: "js/plugins/Credits.js",
      text: "致谢",
      translation: "Credits",
      line: 'if (name === "致谢") show();',
    },
  ]);
});
