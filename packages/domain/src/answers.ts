import type { AnswerContext, Entry, RejectReason } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import { sourceLeft, sourceScript, withoutStrayNumber } from "./checks.ts";
import { isColorCode, keepsControlCodes } from "./controlCodes.ts";
import { plainDashes } from "./dashes.ts";
import { requestText, withCodes, withoutCodes, type RequestText } from "./requestText.ts";
import { onceEach } from "./sounds.ts";

const placeholder = /\{(\d+)\}/g;

const suggestibleReasons: ReadonlyArray<RejectReason> = [
  "placeholder missing",
  "placeholder extra",
  "placeholder repeated",
  "source text left",
  "validation failed",
];
/** Whether an answer rejected for this reason is worth showing the user to fix by hand. */
export const isSuggestible = (reason: RejectReason) => suggestibleReasons.includes(reason);

/** The flag an answer gets when it is longer than its image has room for. */
export const tooLongForImage = "longer than the image has room for";

/** How many characters the translation shows, with codes left out and spaces collapsed. */
export const shownLength = (translation: string) =>
  withoutCodes(translation).replace(/\s+/g, " ").trim().length;

// Color placeholders may be missing or repeated (only the first is kept); any other must appear
// once. Once a color is missing, the others go too, so no color runs on past its end.
function checkPlaceholders(
  answer: string,
  codes: ReadonlyArray<string>,
): Result.Result<string, RejectReason> {
  const counts = new Map<number, number>();
  for (const [, n] of answer.matchAll(placeholder))
    counts.set(Number(n), (counts.get(Number(n)) ?? 0) + 1);
  if (codes.some((code, i) => !isColorCode(code) && !counts.has(i + 1)))
    return Result.fail("placeholder missing");
  if ([...counts.keys()].some((n) => n < 1 || n > codes.length))
    return Result.fail("placeholder extra");
  if (codes.some((code, i) => !isColorCode(code) && (counts.get(i + 1) ?? 0) > 1))
    return Result.fail("placeholder repeated");
  const noColors = codes.some((code, i) => isColorCode(code) && !counts.has(i + 1));
  const seen = new Set<number>();
  return Result.succeed(
    answer.replace(placeholder, (found, n: string) => {
      if (seen.has(Number(n)) || (noColors && isColorCode(codes[Number(n) - 1] ?? ""))) return "";
      seen.add(Number(n));
      return found;
    }),
  );
}

/**
 * The answer without a speaker's name in front: the game shows the speaker already, but answers
 * sometimes start with `Name: "…"` anyway, or with part of the name ("Roy:" for Roy Stone).
 */
export function withoutSpeakerPrefix(
  request: RequestText,
  answer: string,
  speaker: AnswerContext["speaker"],
) {
  if (!speaker?.translation || !speaker.source) return answer;
  if (new RegExp(`^\\s*${RegExp.escape(speaker.source)}\\s*[:：]`).test(request.text))
    return answer;
  const name = speaker.translation;
  const names = [name, ...name.split(/\s+/).filter((part) => part !== name && part.length > 1)]
    .map((part) => RegExp.escape(part))
    .join("|");
  const prefix = new RegExp(`^((?:\\s*\\{\\d+\\})*)\\s*(?:${names})\\s*:\\s*`, "i").exec(answer);
  return prefix ? (prefix[1] ?? "") + answer.slice(prefix[0].length) : answer;
}

// Models sometimes put a line in quotes as if someone said it, which the source doesn't.
function withoutQuotes(request: RequestText, answer: string) {
  const quoted = /^(\s*(?:\{\d+\})*)\s*(?:"([^"]*)"|“([^“”]*)”)\s*$/.exec(answer);
  return quoted && !/^\s*["“「『]/.test(request.text)
    ? (quoted[1] ?? "") + (quoted[2] ?? quoted[3] ?? "")
    : answer;
}

const lineCount = (text: string) => text.split("\n").length;

// Models sometimes wrap a glossary term in braces, as in "{thief}s", which the game would show.
const braces = (text: string) => text.replace(placeholder, "").match(/[{}]/g)?.length ?? 0;

// The answers to other entries, as JSON (`"2": "…"`) or after their ids on lines of their own.
const otherEntries = /"\d+"\s*:|\n[ \t]*\d+[ \t]*\n/;

/** An answer a run takes, with why it is worth a look when it is. */
export interface AcceptedAnswer {
  readonly translation: string;
  readonly flag?: string;
}

/** Checks a model's answer for an entry, with the entry's control codes put back when it passes. */
export function checkAnswer(
  entry: Pick<Entry, "source" | "file" | "path">,
  answer: string | undefined,
  { glossary = [], speaker, limit }: AnswerContext = {},
): Result.Result<AcceptedAnswer, RejectReason> {
  const request = requestText(entry, (name) => name === speaker?.source);
  const value =
    answer === undefined
      ? ""
      : onceEach(
          request.text,
          withoutStrayNumber(
            entry.source,
            withoutQuotes(request, withoutSpeakerPrefix(request, answer, speaker)),
          ),
        );
  if (!value.trim()) return Result.fail("no answer");
  if (
    otherEntries.test(value) &&
    !otherEntries.test(request.text) &&
    !otherEntries.test(entry.source)
  )
    return Result.fail("other entries included");
  // Source text sent back unchanged was not translated; English such as "HP" may stay.
  if (value.trim() === request.text.trim() && sourceScript.test(value))
    return Result.fail("unchanged");
  if (braces(value) > braces(request.text)) return Result.fail("placeholder extra");
  return Result.flatMap(checkPlaceholders(value, request.codes), (kept) => {
    const ownChinese = glossary.filter(
      (term) => sourceScript.test(term.translation) && request.text.includes(term.source),
    );
    const rest = ownChinese.reduce((text, term) => text.split(term.translation).join(""), kept);
    if (sourceLeft(request.text, rest)) return Result.fail("source text left");
    const translation = withCodes(request, plainDashes(kept));
    if (translation && !keepsControlCodes(entry.source, translation))
      return Result.fail("validation failed");
    const flags = [
      ...(lineCount(kept) === lineCount(request.text)
        ? []
        : ["line breaks differ from the source"]),
      ...(limit !== undefined && shownLength(translation) > limit ? [tooLongForImage] : []),
    ];
    return Result.succeed(flags.length ? { translation, flag: flags.join("; ") } : { translation });
  });
}

/** A rejected answer as the user would fix it: control codes back where it has their placeholders. */
export const answerSuggestion = (
  request: RequestText,
  answer: string,
  speaker: AnswerContext["speaker"],
) => withCodes(request, plainDashes(withoutSpeakerPrefix(request, answer, speaker)));

/**
 * Whether a batch's answers moved up one entry: a model that merges two lines into one answer
 * gives every later line the answer to the next one, and the last line an empty answer or a copy
 * of the one before it. Short copies such as "Huh?" may be right.
 */
export function outOfOrder(
  batch: ReadonlyArray<{ readonly text: string }>,
  answers: ReadonlyArray<string | undefined>,
) {
  const [before, last] = answers.slice(-2).map((answer) => answer?.trim() ?? "");
  const [beforeText, lastText] = batch.slice(-2).map((item) => item.text.trim());
  return (
    batch.length > 1 &&
    !!before &&
    (!last || (last === before && last.split(/\s+/).length >= 4 && lastText !== beforeText))
  );
}
