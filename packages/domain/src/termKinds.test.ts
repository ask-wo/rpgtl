import { assert, it } from "@effect/vitest";
import type { Entry, GlossaryTerm } from "@rpgtl/contracts";
import { termInputs } from "./index.ts";

const entry = (file: string, path: string[], source: string, speaker?: string): Entry => ({
  id: `${file}:${path.join(".")}`,
  file,
  path,
  source,
  translation: {},
  ...(speaker && { speaker }),
});
const glossaryTerm = (source: string, extra: Partial<GlossaryTerm> = {}): GlossaryTerm => ({
  source,
  translation: { user: source },
  kind: { guess: { value: "name" } },
  ...extra,
});

const entries = [
  entry("Actors.json", ["1", "name"], "菲奥娜"),
  entry("Items.json", ["3", "name"], "星辉石"),
  entry("Map002.json", ["displayName"], "巴伦镇"),
  entry("Map001.json", ["events", "1", "pages", "0", "list", "0", "parameters", "4"], "NPC"),
  entry("Map001.json", ["events", "1", "pages", "0", "list", "1", "parameters", "0"], "你好。"),
  entry("Map001.json", ["events", "2", "list", "1", "parameters", "0"], "\\n<维多利亚>走吧。"),
  entry("Map001.json", ["events", "3", "list", "1", "parameters", "0"], "看，星辉石！", "菲奥娜"),
  entry("Map001.json", ["events", "4", "list", "1", "parameters", "0"], "我们去巴伦镇吧。"),
  entry("System.json", ["terms", "commands", "0"], "星辉石"),
];

it("kind questions say where the game uses a term and quote lines that mention it", () => {
  const terms = ["菲奥娜", "星辉石", "巴伦镇", "NPC", "维多利亚", "旅馆"].map((s) =>
    glossaryTerm(s),
  );
  assert.deepStrictEqual(termInputs(entries, terms), [
    { term: "菲奥娜", usedAs: ["actor name", "speaker"], lines: [] },
    { term: "星辉石", usedAs: ["item name", "menu or system term"], lines: ["看，星辉石！"] },
    { term: "巴伦镇", usedAs: ["map name"], lines: ["我们去巴伦镇吧。"] },
    { term: "NPC", usedAs: ["speaker"], lines: [] },
    { term: "维多利亚", usedAs: ["speaker"], lines: [] },
    { term: "旅馆", usedAs: [], lines: [] },
  ]);
});
