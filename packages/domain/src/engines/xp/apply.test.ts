import type { Entry } from "@rpgtl/contracts";
import { assert, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { applyXpTranslations, decodeXpFile, xpGameEntries } from "../../index.ts";
import { command, xpFile, xpMap, xpScripts } from "../../testUtils/xpGame.ts";
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

it("puts translations into an XP game's scripts, keeping their `#{}` code and the strings kept as they are, and the script that fits English before Main", () => {
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
    { name: "RPGTL text fitting", code: textFittingScript },
    { name: "Main", code: "begin_game" },
  ]);
});
