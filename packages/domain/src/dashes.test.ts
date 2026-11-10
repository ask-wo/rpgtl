import { assert, it } from "@effect/vitest";
import { plainDashes } from "./index.ts";

it('Dashes become a comma, a full stop, "..." or a hyphen, keeping placeholders and control codes', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["with the air growing thick—as if she was", "with the air growing thick, as if she was"],
    ["wait—deep within this prison—waiting", "wait, deep within this prison, waiting"],
    ["She stood up—she still had things to do.", "She stood up. She still had things to do."],
    ["her senses were fading—That was", "her senses were fading. That was"],
    ["{1}—Wait! Not there—", "{1}Wait! Not there..."],
    ["“Stop——”", "“Stop...”"],
    ["Wait…—no!", "Wait… no!"],
    ["pages 3–5 and A – B", "pages 3–5 and A, B"],
    ["You—you broke her—her toy", "You-you broke her-her toy"],
    ["Wha—What?", "Wha-What?"],
    ["Sav—e—me... it’s—so heavy", "Sav-e-me... it’s, so heavy"],
    ["\\n<Xinglan>—Wait—\\!", "\\n<Xinglan>Wait...\\!"],
    ["I was wrong—\\C[2]please\\C[0]", "I was wrong, \\C[2]please\\C[0]"],
  ];
  for (const [answer, expected] of cases) assert.strictEqual(plainDashes(answer), expected);
});
