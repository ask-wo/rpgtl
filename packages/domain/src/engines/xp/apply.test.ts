import type { Entry } from "@rpgtl/contracts";
import { assert, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { applyXpTranslations, decodeXpFile, patchXpFile, xpGameEntries } from "../../index.ts";
import { command, xpFile, xpMap, xpScripts } from "../../testUtils/xpGame.ts";
import { xpImageScript } from "./images.ts";
import { textFittingScript } from "./textFitting.ts";

const translated = (entries: ReadonlyArray<Entry>, english: Record<string, string>) =>
  entries.map((entry) => ({ ...entry, translation: { user: english[entry.source] ?? "" } }));

const entriesOf = (name: string, bytes: Uint8Array) =>
  xpGameEntries([Result.getOrThrow(decodeXpFile(name, bytes))]);

it("puts translations into an XP data file, wrapping messages into as many as they need and scripts into as many lines, without spaces after their `\\n` codes", () => {
  const map = xpFile(
    xpMap({
      1: [
        command(355, `$who = "店主"`),
        command(355, "say('"),
        command(655, "龙'"),
        command(122, 1, 1, 0, 0, -99999999),
        command(101, "第一行"),
        command(401, "第二行"),
        command(102, ["买", "走"], 2),
        command(402, 0, "买"),
      ],
    }),
  );
  const long = Array.from({ length: 7 }, (_, at) => `Line ${at} is long enough to need a row`);
  const english = {
    店主: 'The "shop" #1',
    "\n龙": "\nThe dragon's \\n lair\nden",
    "第一行\n第二行": `\\N[1] ${long.join(" ")}`,
    买: "Buy",
    走: "Leave",
  };
  const result = Result.getOrThrow(
    applyXpTranslations("Map001.rxdata", map, translated(entriesOf("Map001.rxdata", map), english)),
  );
  const file = Result.getOrThrow(decodeXpFile("Map001.rxdata", result ?? new Uint8Array()));
  const list = file._tag === "Map" ? file.data.events[1]?.pages[0]?.list : undefined;
  assert.deepStrictEqual(
    list?.map(({ code, parameters }) => [code, ...parameters]),
    [
      [355, `$who = "The \\"shop\\" #1"`],
      [355, "say('"],
      [655, "The dragon\\'s \\\\nlair"],
      [655, "den'"],
      [122, 1, 1, 0, 0, -99999999],
      [101, "\\N[1] Line 0 is long enough to need a row "],
      [401, "Line 1 is long enough to need a row Line 2 is long "],
      [401, "enough to need a row Line 3 is long enough to "],
      [401, "need a row Line 4 is long enough to need a row "],
      [101, "Line 5 is long enough to need a row Line 6 is long "],
      [401, "enough to need a row"],
      [102, ["Buy", "Leave"], 2],
      [402, 0, "Buy"],
      [0],
    ],
  );
});

it("puts translations into an XP game's scripts, keeping their `#{}` code and the strings kept as they are, and RPGTL's scripts before Main", () => {
  const scripts = xpFile(
    xpScripts({
      Window_Gold: `draw_text(0, 0, 120, 32, "金币：#{@gold}")\nreturn '盾' if x\ntext = "龙"`,
      Main: "begin_game",
    }),
  );
  const english = { "金币：#{@gold}": 'Gold "now": #{@gold}', 盾: "Shield's", 龙: "Dragon" };
  const entries = translated(entriesOf("Scripts.rxdata", scripts), english).map((entry) =>
    entry.source === "龙" ? { ...entry, keepOriginal: true } : entry,
  );
  const result = Result.getOrThrow(applyXpTranslations("Scripts.rxdata", scripts, entries));
  const file = Result.getOrThrow(decodeXpFile("Scripts.rxdata", result ?? new Uint8Array()));
  assert.deepStrictEqual(file._tag === "Scripts" ? file.data : undefined, [
    {
      name: "Window_Gold",
      code: `draw_text(0, 0, 120, 32, "Gold \\"now\\": #{@gold}")\nreturn 'Shield\\'s' if x\ntext = "龙"`,
    },
    { name: "RPGTL image text", code: xpImageScript },
    { name: "RPGTL text fitting", code: textFittingScript },
    { name: "Main", code: "begin_game" },
  ]);
});

it("puts a space where a translated script string is joined with `+` to a value or a string, between letters or digits", () => {
  const code = [
    `text = "炎の力が" + @rate.to_s + "%上がる"`,
    `text = kind + "器量+" + bonus.to_s`,
    `text = "微風" + "小径" + "\\n" + "HP" + "癒やし歌"`,
    `text += "雷鳴鼓"`,
  ].join("\n");
  const scripts = xpFile(xpScripts({ Window_Bonus: code, Main: "begin_game" }));
  const english = {
    炎の力が: "Raises fire power by",
    "%上がる": "% more",
    "器量+": "GRC+",
    微風: "Zephyr",
    小径: "Quillwind",
    癒やし歌: "Rumblor",
    雷鳴鼓: "Zephyrine",
  };
  const entries = translated(entriesOf("Scripts.rxdata", scripts), english);
  const result = Result.getOrThrow(applyXpTranslations("Scripts.rxdata", scripts, entries));
  const file = Result.getOrThrow(decodeXpFile("Scripts.rxdata", result ?? new Uint8Array()));
  assert.strictEqual(
    file._tag === "Scripts" ? file.data[0]?.code : undefined,
    [
      `text = "Raises fire power by " + @rate.to_s + "% more"`,
      `text = kind + " GRC+" + bonus.to_s`,
      `text = "Zephyr " + "Quillwind" + "\\n" + "HP" + " Rumblor"`,
      `text += "Zephyrine"`,
    ].join("\n"),
  );
});

const scriptsOf = (bytes: Uint8Array | undefined) => {
  const file = Result.getOrThrow(decodeXpFile("Scripts.rxdata", bytes ?? new Uint8Array()));
  return file._tag === "Scripts" ? file.data.map((script) => script.name) : undefined;
};

it("adds an XP game's fixes before Main, before RPGTL's scripts when the scripts are translated too", () => {
  const scripts = xpFile(xpScripts({ Game_Action: "def copy; end", Main: "begin_game" }));
  const fix = { name: "copy.rb", code: "class Game_Action; def copy; dup; end; end" };
  const fixed = Result.getOrThrow(patchXpFile("Scripts.rxdata", scripts, undefined, [fix]));
  assert.deepStrictEqual(scriptsOf(fixed), ["Game_Action", "RPGTL fix copy.rb", "Main"]);
  const both = Result.getOrThrow(patchXpFile("Scripts.rxdata", scripts, [], [fix]));
  assert.deepStrictEqual(scriptsOf(both), [
    "Game_Action",
    "RPGTL fix copy.rb",
    "RPGTL image text",
    "RPGTL text fitting",
    "Main",
  ]);
  assert.isUndefined(Result.getOrThrow(patchXpFile("Scripts.rxdata", scripts, undefined, [])));
});
