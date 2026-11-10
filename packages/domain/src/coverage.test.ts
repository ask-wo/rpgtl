import { assert, it } from "@effect/vitest";
import { type GameContents, missingText, newEntry, textInLogic } from "./index.ts";

const map = {
  events: [
    null,
    {
      pages: [
        {
          list: [
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
  dataFiles: [{ name: "Map009.json", data: map }],
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
  ],
};

it("Coverage lists text no entry covers, by where it is, and leaves out a script's own text", () => {
  assert.deepStrictEqual(missingText(contents, ["System.json"], catalog), [
    {
      where: "Map*.json code 108 parameter 0 (file not read by RPGTL)",
      count: 1,
      examples: ["注释"],
    },
    // The condition is game logic, which `textInLogic` checks; its text isn't extracted.
    {
      where: "Map*.json code 111 parameter 1 (file not read by RPGTL)",
      count: 1,
      examples: ['$gameActors.actor(1).name() == "致谢"'],
    },
    { where: "plugins.js Credits", count: 1, examples: ["制作"] },
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
