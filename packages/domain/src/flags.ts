import type { CheckName, Finding } from "@rpgtl/contracts";
import { lineBreaksDiffer } from "./answers.ts";

/** How sure a flag is: a problem to fix, or a warning about something that is often fine. */
export type FlagLevel = "problem" | "warning";

const checkLevels: Record<CheckName, FlagLevel> = {
  "source text left": "problem",
  "speaker name repeated": "problem",
  "number added on a last line": "problem",
  refusal: "problem",
  "| unlike the source": "problem",
  "glossary name missing": "problem",
  "length unlike the source": "warning",
  "pronoun unlike the source": "warning",
  "plural after a number": "warning",
  "no space after a value": "warning",
};

/** The flag a run gives English it asked again for, which fits where the game draws it. */
export const shortenedToFit = "shortened to fit where the game draws it";

const warningFlags = [lineBreaksDiffer, "shortened to fit"];

export interface Flag {
  readonly note: string;
  readonly level: FlagLevel;
}

/** A translation's flags: those its run wrote, joined with "; ", then what the checks found. */
export const translationFlags = (
  flagReason: string | undefined,
  findings: ReadonlyArray<Finding>,
): ReadonlyArray<Flag> => [
  ...(flagReason ?? "")
    .split("; ")
    .filter((note) => note !== "")
    .map((note): Flag => ({
      note,
      level: warningFlags.some((flag) => note.startsWith(flag)) ? "warning" : "problem",
    })),
  ...findings.map(({ check, detail }): Flag => ({
    note: detail ? `${check} (${detail})` : check,
    level: checkLevels[check],
  })),
];
