import { controlCodePattern } from "./controlCodes.ts";

// Models write em dashes far more often than English game text uses them, and Chinese
// sources often have none where the answer has one. Machine translations get plain
// punctuation instead.

// An em dash, a horizontal bar, a run of them, or an en dash that isn't a number range.
const dash = /\s*(?:[—―]+|(?<!\d)\s*–\s*(?!\d))\s*/g;
// Placeholders such as {1} and control codes such as \C[2] or \n<Xinglan> show no words.
const codes = new RegExp(`\\{\\d+\\}|${controlCodePattern.source}`, "g");
const leadingCodes = new RegExp(`^(?:${codes.source})*`);
// Words that start a new sentence after a dash rather than continue the old one.
const sentenceStart =
  /^(?:That|This|These|Those|It|Its|The|There|They|She|He|We|You|But|And|So|Then|Even|What|How|Why)\b/;
// A pronoun followed by its verb starts a new clause too ("Trampling it—it is just a choice").
const clauseStart = /^(?:she|he|they|it|we|you|i)(?=\s|['’])/;

// "her—her" and "Wha—What" break off and repeat, and "Sav—e—me" stammers in pieces of one
// letter: these get a hyphen ("her-her", "Sav-e-me").
const letter = (part: string) => part.length === 1 && !/[ia]/.test(part);

function stutter(before: string, after: string, dashText: string) {
  // "it’s—so" ends in a whole word, not a piece of one.
  const last = /[\p{L}’']+$/u.exec(before)?.[0].toLowerCase();
  const next = /^\p{L}+/u.exec(after)?.[0].toLowerCase();
  if (!last || !next || /[’']/.test(last)) return undefined;
  if (next.startsWith(last)) return "-";
  return !/\s/.test(dashText) && (letter(last) || letter(next)) ? "-" : undefined;
}

/** Replaces dashes with a comma, a full stop or "...", keeping placeholders and control codes. */
export function plainDashes(text: string) {
  let result = "";
  let last = 0;
  for (const match of text.matchAll(dash)) {
    const before = text.slice(0, match.index);
    let after = text.slice(match.index + match[0].length);
    const broken = stutter(before, after, match[0]);
    let replacement: string;
    const ending = /^\s*(?:$|[!?.,;:…”’"')\]\n])/.test(after.replace(leadingCodes, ""));
    if (!/[\p{L}\p{N}]/u.test(before.replace(codes, ""))) replacement = "";
    else if (/(?:[,;:]|\.\.\.|…)$/.test(before)) replacement = ending ? "" : " ";
    else if (ending) replacement = "...";
    else if (broken) replacement = broken;
    else if (sentenceStart.test(after)) replacement = ". ";
    else if (clauseStart.test(after)) {
      replacement = `. ${after.charAt(0).toUpperCase()}`;
      after = after.slice(1);
    } else replacement = ", ";
    result += text.slice(last, match.index) + replacement;
    last = text.length - after.length;
  }
  return result + text.slice(last);
}
