import { expect, test } from "vite-plus/test";
import { canExpand, decodeCommands, namesFromGame } from "./commands.ts";
import type { Command, Line } from "./commands.ts";

// Game_Interpreter command methods in RPG Maker MV's rpg_objects.js and MZ's rmmz_objects.js.
const mvCodes = [
  101, 102, 103, 104, 105, 108, 111, 112, 113, 115, 117, 118, 119, 121, 122, 123, 124, 125, 126,
  127, 128, 129, 132, 133, 134, 135, 136, 137, 138, 139, 140, 201, 202, 203, 204, 205, 206, 211,
  212, 213, 214, 216, 217, 221, 222, 223, 224, 225, 230, 231, 232, 233, 234, 235, 236, 241, 242,
  243, 244, 245, 246, 249, 250, 251, 261, 281, 282, 283, 284, 285, 301, 302, 303, 311, 312, 313,
  314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326, 331, 332, 333, 334, 335, 336,
  337, 339, 340, 342, 351, 352, 353, 354, 355, 356, 402, 403, 411, 413, 601, 602, 603,
];
const mzCodes = [...mvCodes, 109, 357].toSorted((a, b) => a - b);
const command = (code: number, parameters: unknown[] = [], indent = 0): Command => ({
  code,
  indent,
  parameters,
});
const flatten = (lines: Line[]): Line[] =>
  lines.flatMap((line) => [line, ...flatten(line.children)]);
const shape = (lines: Line[]): unknown[] => lines.map((line) => [line.label, shape(line.children)]);
const emptyNames = namesFromGame({});

test("Every engine code decodes", () => {
  const params: Record<number, unknown[]> = {
    101: ["Actor1", 1, 0, 2, "Guide"],
    102: [["Yes", "No"], -2, 0, 2, 0],
    103: [1, 4],
    104: [1, 2],
    105: [2, false],
    108: ["Comment"],
    111: [0, 1, 0],
    117: [1],
    118: ["Here"],
    119: ["Here"],
    121: [1, 1, 0],
    122: [1, 1, 0, 0, 5],
    123: ["A", 0],
    124: [0, 60],
    125: [0, 0, 10],
    126: [1, 0, 0, 1],
    127: [1, 0, 0, 1, true],
    128: [1, 0, 0, 1, true],
    129: [1, 0, true],
    132: [{ name: "Battle", volume: 90, pitch: 100, pan: 0 }],
    133: [{ name: "Victory", volume: 90, pitch: 100, pan: 0 }],
    134: [0],
    135: [1],
    136: [0],
    137: [1],
    138: [[0, 0, 0, 0]],
    139: [{ name: "Defeat", volume: 90, pitch: 100, pan: 0 }],
    140: [0, { name: "Boat", volume: 90, pitch: 100, pan: 0 }],
    201: [0, 1, 3, 4, 2, 0],
    202: [0, 0, 1, 3, 4],
    203: [0, 0, 3, 4, 2],
    204: [2, 5, 4, true],
    205: [
      0,
      {
        list: [{ code: 1, parameters: [] }, { code: 0 }],
        repeat: false,
        skippable: false,
        wait: true,
      },
    ],
    211: [0],
    212: [0, 1, true],
    213: [0, 1, true],
    216: [0],
    223: [[0, 0, 0, 0], 60, true],
    224: [[255, 255, 255, 128], 60, true],
    225: [5, 5, 60, true],
    230: [60],
    231: [1, "Picture", 0, 0, 3, 4, 100, 100, 255, 0],
    232: [1, "", 0, 0, 3, 4, 100, 100, 255, 0, 60, true, 1],
    233: [1, 5],
    234: [1, [0, 0, 0, 0], 60, true],
    235: [1],
    236: ["rain", 5, 60, true],
    241: [{ name: "Theme", volume: 90, pitch: 100, pan: 0 }],
    242: [3],
    245: [{ name: "Rain", volume: 90, pitch: 100, pan: 0 }],
    246: [3],
    249: [{ name: "Jingle", volume: 90, pitch: 100, pan: 0 }],
    250: [{ name: "Bell", volume: 90, pitch: 100, pan: 0 }],
    261: ["Movie"],
    281: [0],
    282: [1],
    283: ["Forest", "Trees"],
    284: ["Sky", true, false, 1, 0],
    285: [1, 0, 0, 3, 4],
    301: [0, 1, true, true],
    302: [0, 1, 0, 0, false],
    303: [1, 8],
    311: [0, 1, 0, 0, 10, true],
    312: [0, 1, 0, 0, 10],
    313: [0, 1, 0, 1],
    314: [0, 1],
    315: [0, 1, 0, 0, 10, true],
    316: [0, 1, 0, 0, 1, true],
    317: [0, 1, 2, 0, 0, 10],
    318: [0, 1, 0, 1],
    319: [1, 1, 1],
    320: [1, "Name"],
    321: [1, 1, true],
    322: [1, "Actor1", 0, "Actor1", 0, "Actor1"],
    323: [0, "Vehicle", 0],
    324: [1, "Nickname"],
    325: [1, "Profile"],
    326: [0, 1, 0, 0, 10],
    331: [0, 0, 0, 10, true],
    332: [0, 0, 0, 10],
    333: [0, 0, 1],
    334: [0],
    335: [0],
    336: [0, 1],
    337: [0, 1, true],
    339: [0, 0, 1, -1],
    342: [0, 0, 0, 10],
    355: ["const a = 1;"],
    356: ["Plugin argument"],
    357: ["Plugin", "Command", "Comment", { argument: "value" }],
    402: [0, "Yes"],
  };
  const extras: Record<number, Command[]> = {
    101: [command(401, ["Text\\V[1]"]), command(401, ["More text"])],
    105: [command(405, ["Scrolling"])],
    108: [command(408, ["More comment"])],
    205: [
      command(505, [{ code: 1, parameters: [] }]),
      command(505, [{ code: 45, parameters: ["a();"] }]),
    ],
    302: [command(605, [1, 2, 1, 50])],
    355: [command(655, ["a();"])],
    357: [command(657, ["argument = value"])],
  };
  const list = mzCodes.flatMap((code) => [
    command(code, params[code] ?? []),
    ...(extras[code] ?? []),
  ]);
  list.push(command(999, ["unknown", { x: 1 }]));
  const lines = flatten(decodeCommands(list, emptyNames));
  expect(lines.filter((line) => /^Code \d+$/.test(line.label)).map((line) => line.code)).toEqual([
    999,
  ]);
  expect(lines.find((line) => line.code === 999)?.detail).toBe('["unknown",{"x":1}]');
  expect(
    lines
      .filter((line) => line.code !== 505)
      .map((line) => line.code)
      .toSorted((a, b) => a - b),
  ).toEqual([...mzCodes.filter((code) => code !== 413), 999]);
  for (const line of lines) {
    const original = list.find((c) => c.code === line.code)!;
    if (line.code === 505) {
      expect(extras[205]!.some((c) => c.parameters === line.raw[0]?.parameters)).toBe(true);
    } else {
      expect(line.raw).toEqual(
        [original, ...(extras[line.code] ?? [])].map(({ code, parameters }) => ({
          code,
          parameters,
        })),
      );
      expect(line.raw[0]?.parameters).toBe(original.parameters);
    }
  }
  expect(lines.find((line) => line.code === 101)?.detail).toBe("Guide: Text\\V[1]\nMore text");
  expect(lines.find((line) => line.code === 105)?.detail).toBe("Scrolling");
  expect(lines.find((line) => line.code === 108)?.detail).toBe("Comment\nMore comment");
  expect(lines.find((line) => line.code === 355)?.detail).toBe("const a = 1;\na();");
  expect(lines.find((line) => line.code === 357)?.detail).toBe("Plugin: Command\nargument = value");
  expect(
    lines.find((line) => line.code === 205)?.children.map(({ label, detail }) => [label, detail]),
  ).toEqual([
    ["Move down", ""],
    ["Script", "a();"],
  ]);
  expect(lines.find((line) => line.code === 302)?.detail).toBe(
    "Item 1, price standard\nWeapon 2, price 50",
  );
});

test("Named references", () => {
  const switches: string[] = [];
  switches[12] = "Met teacher";
  const variables: string[] = [];
  variables[7] = "Gold found";
  const maps = [];
  maps[5] = { name: "Office" };
  const events = [];
  events[3] = { name: "Sleep" };
  const names = namesFromGame({
    $dataSystem: { switches, variables },
    $dataMapInfos: maps,
    $dataCommonEvents: events,
    $gameSwitches: { value: () => false },
    $gameVariables: { value: () => 40 },
  });
  const lines = decodeCommands(
    [
      command(121, [12, 12, 0]),
      command(201, [0, 5, 3, 4, 0, 0]),
      command(117, [3]),
      command(122, [7, 7, 1, 0, 5]),
      command(101, ["Actor1", 1, 0, 2, "Guide"]),
      command(401, ["Welcome!"]),
      command(401, ["Stay a while."]),
    ],
    names,
  );
  expect(lines.map(({ label, detail }) => [label, detail])).toEqual([
    ["Control Switches", 'Switch 12 "Met teacher" = ON (now OFF)'],
    ["Transfer Player", 'Map 5 "Office" (3, 4)'],
    ["Call Common Event", '3 "Sleep"'],
    ["Control Variables", 'Variable 7 "Gold found" += 5 (now 40)'],
    ["Show Text", "Guide: Welcome!\nStay a while."],
  ]);
  expect(lines[2]?.commonEvent).toBe(3);
});

test("Script details keep line breaks and annotate literal variable reads and writes", () => {
  const variables: string[] = [];
  variables[104] = "职业";
  variables[117] = "Target";
  const names = namesFromGame({
    $dataSystem: { variables },
    $gameVariables: { value: (id) => (id === 104 ? "Teacher" : id === 117 ? 0 : undefined) },
  });
  const lines = decodeCommands(
    [
      command(355, ["$gameVariables.value(104);"]),
      command(655, ["$gameVariables.setValue(117, 0);"]),
    ],
    names,
  );
  expect(lines[0]?.detail).toBe(
    '$gameVariables.value(104) ‹职业 = "Teacher"›;\n$gameVariables.setValue(117, 0) ‹Target = 0›;',
  );
});

test("Displayed text resolves game control codes", () => {
  const names = namesFromGame({
    $dataSystem: { currencyUnit: "Gold" },
    $gameVariables: { value: (id) => (id === 102 ? "Human" : undefined) },
    $gameActors: { actor: (id) => (id === 1 ? { name: () => "Hero" } : undefined) },
  });
  const lines = decodeCommands(
    [
      command(101, ["", 0, 0, 2, ""]),
      command(401, ["\\n<Guide>\\C[2]Race\\C[0]: \\V[102]\\{!\\}"]),
      command(401, ["\\N[1] has 50\\G \\I[64]\\Custom[3]"]),
    ],
    names,
  );
  expect(lines.map(({ label, detail }) => [label, detail])).toEqual([
    ["Show Text", "Guide: Race: Human!\nHero has 50Gold \\Custom[3]"],
  ]);
});

test("Nesting", () => {
  const show = (indent: number, text: string) => [
    command(101, ["", 0, 0, 2], indent),
    command(401, [text], indent),
    command(0, [], indent),
  ];
  const list = [
    command(102, [["Yes", "No"], -2]),
    command(402, [0, "Yes"]),
    command(111, [0, 1, 0], 1),
    ...show(2, "True"),
    command(411, [], 1),
    ...show(2, "False"),
    command(412, [], 1),
    command(0, [], 1),
    command(402, [1, "No"]),
    ...show(1, "No"),
    command(403),
    ...show(1, "Cancel"),
    command(404),
    command(112),
    ...show(1, "Loop"),
    command(113, [], 1),
    command(0, [], 1),
    command(413),
    command(301, [0, 1, false, true]),
    command(601),
    ...show(1, "Win"),
    command(603),
    ...show(1, "Lose"),
    command(604),
    command(0),
  ];
  const lines = decodeCommands(list, emptyNames);
  expect(shape(lines)).toEqual([
    [
      "Show Choices",
      [
        [
          "When Yes",
          [
            ["Conditional Branch", [["Show Text", []]]],
            ["Else", [["Show Text", []]]],
          ],
        ],
        ["When No", [["Show Text", []]]],
        ["When Cancel", [["Show Text", []]]],
      ],
    ],
    [
      "Loop",
      [
        ["Show Text", []],
        ["Break Loop", []],
      ],
    ],
    [
      "Battle Processing",
      [
        ["If Win", [["Show Text", []]]],
        ["If Lose", [["Show Text", []]]],
      ],
    ],
  ]);
  expect(flatten(lines).filter((line) => [0, 404, 412, 413, 604].includes(line.code))).toEqual([]);
  expect(
    flatten(lines)
      .filter((line) => line.code === 101)
      .map((line) => line.detail),
  ).toEqual(["True", "False", "No", "Cancel", "Loop", "Win", "Lose"]);
});

test("Self-calling common event", () => {
  expect(canExpand(3, [1, 3])).toBe(false);
  expect(canExpand(4, [1, 3])).toBe(true);
});
