import { assert, it } from "@effect/vitest";
import { lineBreaksDiffer, shortenedToFit, tooLongForRoom, translationFlags } from "./index.ts";

it("a run's flags and the checks' finds are problems or warnings by how often they are wrong", () => {
  assert.deepStrictEqual(
    translationFlags(`${shortenedToFit}; ${tooLongForRoom}`, [
      { check: "glossary name missing", detail: "ベガ → Vega" },
      { check: "plural after a number" },
    ]),
    [
      { note: shortenedToFit, level: "warning" },
      { note: tooLongForRoom, level: "problem" },
      { note: "glossary name missing (ベガ → Vega)", level: "problem" },
      { note: "plural after a number", level: "warning" },
    ],
  );
  assert.deepStrictEqual(translationFlags(lineBreaksDiffer, []), [
    { note: lineBreaksDiffer, level: "warning" },
  ]);
});
