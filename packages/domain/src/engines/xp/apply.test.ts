import type { Entry } from "@rpgtl/contracts";
import { assert, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { applyXpTranslations, decodeXpFile, xpGameEntries } from "../../index.ts";
import { command, xpFile, xpMap } from "../../testUtils/xpGame.ts";

const translated = (entries: ReadonlyArray<Entry>, english: Record<string, string>) =>
  entries.map((entry) => ({ ...entry, translation: { user: english[entry.source] ?? "" } }));

const entriesOf = (name: string, bytes: Uint8Array) =>
  xpGameEntries([Result.getOrThrow(decodeXpFile(name, bytes))]);

it("puts translations into an XP data file, wrapping messages into as many as they need", () => {
  const map = xpFile(
    xpMap({
      1: [
        command(355, `$who = "店主"`),
        command(122, 1, 1, 0, 0, -99999999),
        command(101, "第一行"),
        command(401, "第二行"),
        command(102, ["买", "走"], 2),
        command(402, 0, "买"),
      ],
    }),
  );
  const long = Array.from({ length: 5 }, (_, at) => `Line ${at} is long enough to need a row`);
  const english = {
    店主: 'The "shop" #1',
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
      [122, 1, 1, 0, 0, -99999999],
      [101, "\\N[1] Line 0 is long enough to need a row"],
      [401, "Line 1 is long enough to need a row Line 2 is long"],
      [101, "enough to need a row Line 3 is long enough to"],
      [401, "need a row Line 4 is long enough to need a row"],
      [102, ["Buy", "Leave"], 2],
      [402, 0, "Buy"],
      [0],
    ],
  );
});
