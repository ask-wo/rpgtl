import { isColorCode } from "./controlCodes.ts";

/**
 * The pauses (`\.`, `\|`, `\!`) inside a line, with where they stood in the source, for placing them
 * in an English whose model left out or added pause markers.
 */
export interface Pauses {
  /** The source's runs of punctuation, which the English's are lined up with. */
  readonly marks: ReadonlyArray<Mark>;
  readonly each: ReadonlyArray<Pause>;
}

/** What a request sends where a pause stood, which a model may move with the words around it. */
export const pauseMarker = "⏸";

interface Mark {
  /** How far into the shown text it ends, from 0 to 1. */
  readonly at: number;
  readonly endsSentence: boolean;
  /** Which kinds of punctuation it holds, such as an ellipsis or a comma. */
  readonly kinds: ReadonlyArray<string>;
}

export interface Pause {
  readonly code: string;
  /** How far into the shown text it stood, from 0 to 1. */
  readonly at: number;
  /** The run of punctuation it stood after, or just before with `start`. */
  readonly mark?: { readonly index: number; readonly start: boolean };
  /** The kept line break it stood beside, at the end of the line before or the start of the next. */
  readonly line?: { readonly index: number; readonly of: number; readonly end: boolean };
  /** Beside a line break the request joins, which in Korean and Japanese often ends a sentence. */
  readonly joinedBreak?: true;
}

interface Run {
  readonly start: number;
  readonly end: number;
}

const closers = String.raw`」』）】〕》〉)\]"”'’`;
const sourceMarks = new RegExp(
  String.raw`[…‥。！？!?.,，、;；:：~～—―・❤♥♡♪☆★]+[${closers}]*`,
  "gu",
);
const englishMarks = new RegExp(String.raw`[…!?.,;:~—–❤♥♡♪☆★]+[${closers}]*`, "gu");
const sentenceEnd = /[。！？!?.…‥~～]/;
const markKinds: ReadonlyArray<readonly [string, RegExp]> = [
  ["ellipsis", /…|‥|\.\.|・・/],
  ["stop", /[。.](?<!\.\.)(?!\.)/],
  ["exclamation", /[!！]/],
  ["question", /[?？]/],
  ["comma", /[,，、]/],
  ["colon", /[:：;；]/],
  ["tilde", /[~～]/],
  ["dash", /[—―–]/],
  ["symbol", /[❤♥♡♪☆★]/],
];
const lineBreaks = /[^\S\n]*\n\s*/g;
const placeholders = /\{\d+\}/g;

const latinOrDigit = /[A-Za-z0-9]/;

const runs = (text: string, pattern: RegExp): ReadonlyArray<Run> =>
  [...text.matchAll(pattern)]
    // A point or comma inside a number or abbreviation ("0.2", "e.g") is no pause; Chinese and
    // Korean put commas between words without a space.
    .filter((match) => {
      const before = text[match.index - 1] ?? "";
      const after = text[match.index + match[0].length] ?? "";
      return !(/^[.,:]$/.test(match[0]) && latinOrDigit.test(before) && latinOrDigit.test(after));
    })
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));

const shownLength = (text: string) => text.replace(placeholders, "").replace(/\s+/g, "").length;
const shownShare = (text: string, at: number) =>
  shownLength(text) ? shownLength(text.slice(0, at)) / shownLength(text) : 0;

const marksOf = (text: string, found: ReadonlyArray<Run>): ReadonlyArray<Mark> =>
  found.map((run) => ({
    at: shownShare(text, run.end),
    endsSentence: sentenceEnd.test(text.slice(run.start, run.end)),
    kinds: markKinds
      .filter(([, pattern]) => pattern.test(text.slice(run.start, run.end)))
      .map(([kind]) => kind),
  }));

function pauseAt(
  text: string,
  marks: ReadonlyArray<Run>,
  { code, at }: { readonly code: string; readonly at: number },
  keepLines: boolean,
): Pause {
  const share = shownShare(text, at);
  const lastShown = text.slice(0, at).trimEnd().length;
  const firstShown = text.length - text.slice(at).trimStart().length;
  const after = marks.findIndex((run) => run.start < lastShown && lastShown <= run.end);
  const before = marks.findIndex((run) => run.start === firstShown);
  if (after >= 0 || before >= 0)
    return {
      code,
      at: share,
      mark: after >= 0 ? { index: after, start: false } : { index: before, start: true },
    };
  const breaks = runs(text, lineBreaks);
  const line = breaks.find((run) => run.start <= at && at <= run.end);
  if (line && !keepLines) return { code, at: share, joinedBreak: true };
  if (line) {
    const index = breaks.indexOf(line);
    return { code, at: share, line: { index, of: breaks.length, end: at === line.start } };
  }
  return { code, at: share };
}

/** The pauses found at offsets of the request's text, before its lines are joined. */
export function pausesIn(
  text: string,
  found: ReadonlyArray<{ readonly code: string; readonly at: number }>,
  keepLines: boolean,
): Pauses {
  if (!found.length) return { marks: [], each: [] };
  const marks = runs(text, sourceMarks);
  return {
    marks: marksOf(text, marks),
    each: found.map((pause) => pauseAt(text, marks, pause, keepLines)),
  };
}

const skipCost = 0.2;
const matchCost = (source: Mark, english: Mark) =>
  Math.abs(source.at - english.at) +
  (source.endsSentence === english.endsSentence ? 0 : 0.3) +
  (source.kinds.some((kind) => english.kinds.includes(kind)) ? 0 : 0.15);

/**
 * Which English run of punctuation each source run matches, in order. When the English adds or
 * drops some, they are lined up the way a diff lines up lines, by kind and place in the line.
 */
function align(source: ReadonlyArray<Mark>, english: ReadonlyArray<Mark>) {
  // The same number of runs is the best sign they are the same ones, even when the English made a
  // comma of a full stop or moved a clause.
  if (source.length === english.length) return new Map(source.map((_, i) => [i, i]));
  const cost = Array.from({ length: source.length + 1 }, (_row, i) =>
    Array.from({ length: english.length + 1 }, (_cell, j) => (i + j) * skipCost),
  );
  const at = (i: number, j: number) => cost[i]?.[j] ?? Infinity;
  const pair = source.map((s) => english.map((e) => matchCost(s, e)));
  const paired = (i: number, j: number) => at(i - 1, j - 1) + (pair[i - 1]?.[j - 1] ?? Infinity);
  for (const [i, row] of cost.entries())
    for (const j of row.keys())
      if (i > 0 && j > 0)
        row[j] = Math.min(at(i - 1, j) + skipCost, at(i, j - 1) + skipCost, paired(i, j));
  const matched = new Map<number, number>();
  for (let i = source.length, j = english.length; i > 0 && j > 0;) {
    if (at(i, j) === paired(i, j)) {
      matched.set(i - 1, j - 1);
      i--;
      j--;
    } else if (at(i, j) === at(i - 1, j) + skipCost) i--;
    else j--;
  }
  return matched;
}

// A pause between the words of a colored name would split what the game shows as one.
function colored(answer: string, codes: ReadonlyArray<string>) {
  const spans: Run[] = [];
  let open: number | undefined;
  for (const match of answer.matchAll(placeholders)) {
    const code = codes[Number(match[0].slice(1, -1)) - 1] ?? "";
    if (!isColorCode(code)) continue;
    if (open !== undefined) spans.push({ start: open, end: match.index });
    open = /^\\C\[0\]$/i.test(code) ? undefined : match.index + match[0].length;
  }
  return (at: number) => spans.some((span) => span.start < at && at <= span.end);
}

const nearest = (answer: string, places: ReadonlyArray<number>, at: number) =>
  places.reduce<number | undefined>(
    (best, place) =>
      best === undefined ||
      Math.abs(shownShare(answer, place) - at) < Math.abs(shownShare(answer, best) - at)
        ? place
        : best,
    undefined,
  );

/** The answer with each pause placed where its place in the source suggests. */
export function withPauses(answer: string, pauses: Pauses, codes: ReadonlyArray<string>) {
  if (!pauses.each.length) return answer;
  const found = runs(answer, englishMarks);
  const matched = align(pauses.marks, marksOf(answer, found));
  // The source and English places of the matched punctuation, as fixed points to place between.
  const start = { source: 0, english: 0 };
  const end = { source: 1, english: answer.length };
  const anchors = [
    start,
    ...[...matched]
      .toSorted(([a], [b]) => a - b)
      .flatMap(([s, e]) => {
        const mark = pauses.marks[s];
        const run = found[e];
        return mark && run ? [{ source: mark.at, english: run.end }] : [];
      }),
    end,
  ];
  const inColor = colored(answer, codes);
  const allWords = [...answer.matchAll(/(?<=\s)(?=\S)/g)].map((match) => match.index);
  const words = allWords.filter((word) => !inColor(word));
  // The line's last punctuation is no place for a pause, which would then wait for nothing.
  const inner = found.map((run) => run.end).filter((place) => answer.slice(place).trim());
  const breaks = runs(answer, lineBreaks);

  function fixedPlace(pause: Pause) {
    const english = pause.mark && matched.get(pause.mark.index);
    const run = english === undefined ? undefined : found[english];
    if (pause.mark && run) return pause.mark.start ? run.start : run.end;
    const line =
      pause.line && breaks.length === pause.line.of ? breaks[pause.line.index] : undefined;
    if (pause.line && line) return pause.line.end ? line.start : line.end;
    return undefined;
  }
  const fixed = pauses.each.map(fixedPlace);
  // Places only spaces apart are one place to a reader.
  const shown = (place: number) => place + (/^\s*/.exec(answer.slice(place))?.[0].length ?? 0);
  const taken = new Set(fixed.filter((place) => place !== undefined).map(shown));

  // A pause no punctuation matches goes between the matched punctuation around it, at the same
  // share of the gap, and not where another pause already is.
  function between(pause: Pause, low: number, high: number) {
    const after = anchors.findLast((anchor) => anchor.source <= pause.at) ?? start;
    const before = anchors.find((anchor) => anchor.source >= pause.at) ?? end;
    const from = shownShare(answer, after.english);
    const to = shownShare(answer, before.english);
    const span = before.source - after.source;
    const at = span > 0 ? from + ((pause.at - after.source) / span) * (to - from) : from;
    const free = (place: number) => !taken.has(shown(place)) && place >= low && place <= high;
    // Punctuation a pause followed in the source may be the gap's own edge in the English.
    const lowest = pause.mark ? after.english : after.english + 1;
    const marks = inner.filter(
      (place) => place >= lowest && place <= before.english && free(place),
    );
    const mark = nearest(answer, marks, at);
    const near = mark !== undefined && Math.abs(shownShare(answer, mark) - at) <= 0.2;
    if (near && (pause.joinedBreak || pause.mark)) return mark;
    const inside = (place: number) =>
      place > after.english && place < before.english && free(place);
    return (
      nearest(answer, words.filter(inside), at) ??
      mark ??
      nearest(answer, allWords.filter(inside), at) ??
      Math.max(after.english, low)
    );
  }

  let text = "";
  let last = 0;
  pauses.each.forEach((pause, i) => {
    const high = fixed.slice(i).find((place) => place !== undefined) ?? answer.length;
    const at = Math.max(fixed[i] ?? between(pause, last, high), last);
    taken.add(shown(at));
    text += answer.slice(last, at) + pause.code;
    last = at;
  });
  return text + answer.slice(last);
}
