import type { Entry } from "@rpgtl/contracts";
import { codeOrBackslash, controlCodePattern, isPauseCode, shownText } from "./controlCodes.ts";
import { creditLine, keepsLineBreaks } from "./engines/mvmz/extract.ts";
import { pauseMarker, pausesIn, withPauses, type Pause, type Pauses } from "./pauses.ts";
import type { Placed } from "./location.ts";
import { tagPattern } from "./engines/xp/databaseTags.ts";

// Korean puts spaces between words, so a line break between Hangul joins with a space.
const unspacedCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿！-｠⏸]/u;

const sourceLetter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// A row of codes without words, such as the button icons a tutorial lists, is laid out by its
// line breaks.
const codeRow = (line: string) => /\{\d+\}/.test(line) && !sourceLetter.test(line);

/**
 * Joins the lines of a text, which only fit Chinese text into its window, so the English can be
 * wrapped again. Blank lines between paragraphs stay, and so do the line breaks around a row of
 * placeholders without words, and every line break with `keepLines`.
 */
export function joinLines(text: string, keepLines = false) {
  return text.replace(/[^\S\n]*\n\s*/g, (lineBreak, offset: number, value: string) => {
    if (/\n\s*\n/.test(lineBreak)) return "\n\n";
    const before = value.slice(value.lastIndexOf("\n", offset - 1) + 1, offset);
    const after = value.slice(offset + lineBreak.length).split("\n", 1)[0] ?? "";
    if (keepLines || codeRow(before) || codeRow(after)) return "\n";
    return unspacedCharacter.test(value[offset - 1] ?? "") &&
      unspacedCharacter.test(value[offset + lineBreak.length] ?? "")
      ? ""
      : " ";
  });
}

// Codes that stand for a word move with the English word order, so they are never kept aside.
const wordCode = String.raw`(?:%\d+|#\{[^{}]*\}|\\[NVP]\[[^\]]*\]|\\G(?![A-Za-z[<]))`;
const edgePart = `\\s|(?!${wordCode})(?:${controlCodePattern.source})`;
const keptAside = (codes: string, edge: string) => ({
  leading: new RegExp(`^(?:${edge})*`, "i"),
  trailing: new RegExp(`(?:${edge})*$`, "i"),
  inside: new RegExp(codes, "g"),
});
// A source's own `{2}` would read as a placeholder in the answer, so it is sent as one.
const sourcePlaceholder = String.raw`\{\d+\}`;
const plainPatterns = keptAside(`${codeOrBackslash.source}|${sourcePlaceholder}`, edgePart);
const tagPatterns = keptAside(
  `${tagPattern.source}|${codeOrBackslash.source}|${sourcePlaceholder}`,
  `${tagPattern.source}|${edgePart}`,
);
const placeholder = /\{(\d+)\}/g;

/** The text as a player reads it: no control codes, and lines joined as `joinLines` does. */
export const withoutCodes = (text: string) => joinLines(shownText(text));

/**
 * An entry's source as a request sends it: the control codes at its edges and the pauses inside are
 * kept aside, and each other code inside is replaced by a placeholder `{1}`, `{2}`, ….
 */
export interface RequestText {
  readonly leading: string;
  readonly trailing: string;
  /** The control code each placeholder stands for: `codes[n - 1]` is `{n}`. */
  readonly codes: ReadonlyArray<string>;
  readonly pauses: Pauses;
  readonly text: string;
  /** The speaker's name when it stands alone on the first line, which `leading` then ends with. */
  readonly speakerLine?: string;
}

const colorCode = /\\C\[\d+\]/gi;

// A color at an edge that a color inside the line opens or closes is sent with it, or the model
// sees only one end of the span and the color runs from the English's start or to its end.
function edges(source: string, patterns: typeof plainPatterns) {
  const leading = patterns.leading.exec(source)?.[0] ?? "";
  const trailing = patterns.trailing.exec(source.slice(leading.length))?.[0] ?? "";
  const body = source.slice(leading.length, source.length - trailing.length);
  if (!body.match(colorCode)) return { leading, trailing };
  const first = leading.search(colorCode);
  const last = [...trailing.matchAll(colorCode)].at(-1);
  return {
    leading: first >= 0 ? leading.slice(0, first) : leading,
    trailing: last ? trailing.slice(last.index + last[0].length) : trailing,
  };
}

/**
 * The name on a text's first line when the line is only a speaker's name and more text follows.
 * Games without a name box often write the speaker so. Joined to the text, the name reads as part
 * of the sentence (ミナ⏎と、とにかく逃げて → "Mina and… anyway, run").
 */
export function firstLineSpeaker(text: string, isSpeaker: (name: string) => boolean) {
  const end = text.indexOf("\n");
  const name = shownText(text.slice(0, end)).trim();
  return end >= 0 && name && text.slice(end).trim() && isSpeaker(name) ? name : undefined;
}

function withSpeakerLine(
  leading: string,
  body: string,
  isSpeaker: ((name: string) => boolean) | undefined,
) {
  const name = isSpeaker && firstLineSpeaker(body, isSpeaker);
  if (!name) return { leading, body };
  const end = body.indexOf("\n");
  return {
    leading: leading + body.slice(0, end + 1),
    body: body.slice(end + 1),
    speakerLine: name,
  };
}

/** With `keepTags`, the tags of an XP database name or description are kept aside like control codes. */
export function requestText(
  entry: Pick<Entry, "source"> & Placed,
  isSpeaker?: (name: string) => boolean,
  keepTags = false,
): RequestText {
  const credit = creditLine(entry);
  if (credit)
    return {
      leading: "",
      trailing: credit.names,
      codes: [],
      pauses: pausesIn("", [], false),
      text: credit.role,
    };
  const patterns = keepTags ? tagPatterns : plainPatterns;
  const edge = edges(entry.source, patterns);
  const { trailing } = edge;
  const { leading, body, speakerLine } = withSpeakerLine(
    edge.leading,
    entry.source.slice(edge.leading.length, entry.source.length - trailing.length),
    isSpeaker,
  );
  const keepLines = keepsLineBreaks(entry);
  const codes: string[] = [];
  const found: Array<{ code: string; at: number }> = [];
  let unjoined = "";
  let last = 0;
  for (const match of body.matchAll(patterns.inside)) {
    const [code] = match;
    unjoined += body.slice(last, match.index);
    last = match.index + code.length;
    if (code === "\\") continue;
    if (isPauseCode(code)) found.push({ code, at: unjoined.length });
    else {
      codes.push(code);
      unjoined += `{${codes.length}}`;
    }
  }
  unjoined += body.slice(last);
  const pauses = pausesIn(unjoined, found, keepLines);
  const marked = found.reduceRight(
    (text, { at }) => text.slice(0, at) + pauseMarker + text.slice(at),
    unjoined,
  );
  const text = joinLines(marked, keepLines);
  return { leading, trailing, codes, pauses, text, ...(speakerLine && { speakerLine }) };
}

// A Chinese request joins a pause at a line's end to the next line without a space, and models
// copy that into the English as "up!⏸There".
const markerBetweenSentences = /(?<=[.!?…,;:)"'’”])⏸(?=[\p{L}\p{N}"'‘“(])/gu;
const spacedMarker = /[^\S\n]+⏸[^\S\n]+/g;

// Small models write a marker with spaces on both sides between two words where they leave out the
// comma or period it seemed to replace; a pause inside a sentence comes as "word ⏸word".
const markerForPunctuation = /(?<=\p{L})[^\S\n]+⏸[^\S\n]+(?=(\p{L}+))/gu;

/** The answer with a marker's spaces made those of the English around a pause. */
const spacedMarkers = (answer: string) =>
  answer
    .replace(markerForPunctuation, (_found, word: string) =>
      /^\p{Lu}/u.test(word) && word !== "I" ? `.${pauseMarker} ` : `,${pauseMarker} `,
    )
    .replace(spacedMarker, `${pauseMarker} `)
    .replace(markerBetweenSentences, `${pauseMarker} `);

const droppedMarker = "\u{E000}";
const droppedWithSpaces = /[^\S\n]*\u{E000}[^\S\n]*/gu;

/** The text without its dropped markers, keeping one space where one stood between two words. */
const withoutDropped = (text: string) =>
  text.replace(droppedWithSpaces, (found, at: number, all: string) => {
    const before = all[at - 1] ?? "";
    const after = all[at + found.length] ?? "";
    return found !== droppedMarker && /\S/.test(before) && /[^\s,.!?…;:]/.test(after) ? " " : "";
  });

const edgeMarkers = /^(\s*)⏸|⏸(\s*)$/g;

/** For each place in order, the index of the nearest of `targets`, in order too; `targets` is not shorter. */
function nearestInOrder(places: ReadonlyArray<number>, targets: ReadonlyArray<number>) {
  const picked: Array<number> = [];
  let from = 0;
  places.forEach((place, i) => {
    const last = targets.length - (places.length - i);
    let best = from;
    for (let j = from; j <= last; j++)
      if (Math.abs((targets[j] ?? 0) - place) < Math.abs((targets[best] ?? 0) - place)) best = j;
    picked.push(best);
    from = best + 1;
  });
  return picked;
}

/**
 * The code each of the answer's markers stands for, in order, or none for a marker to drop. A model
 * leaves a pause out on purpose when its English drops or merges the words around it, and adds one
 * where it reads a beat the source doesn't have, so the markers and pauses are matched by their
 * places in the line.
 */
function markerCodes(answer: string, each: ReadonlyArray<Pause>) {
  const shown = answer.replaceAll(pauseMarker, "").length;
  const markers = [...answer.matchAll(/⏸/g)].map(
    (match, i) => (match.index - i) / Math.max(shown, 1),
  );
  const pauses = each.map((pause) => pause.at);
  if (markers.length <= pauses.length)
    return nearestInOrder(markers, pauses).map((j) => each[j]?.code);
  const codes: Array<string | undefined> = markers.map(() => undefined);
  nearestInOrder(pauses, markers).forEach((marker, j) => (codes[marker] = each[j]?.code));
  return codes;
}

const markerCount = (text: string) => text.split(pauseMarker).length - 1;

function markedPauses(request: RequestText, answer: string) {
  const { each } = request.pauses;
  const count = markerCount(answer);
  let spaced = spacedMarkers(answer);
  // A marker at either end copies a pause the source has at its edge, which is added back anyway.
  if (count > each.length) spaced = spaced.replace(edgeMarkers, "$1$2");
  if (!markerCount(spaced)) return withPauses(spaced, request.pauses, request.codes);
  const codes = markerCodes(spaced, each);
  let next = 0;
  return withoutDropped(spaced.replaceAll(pauseMarker, () => codes[next++] ?? droppedMarker));
}

/** An answer with the codes put back: pauses placed, placeholders replaced, and the edges added again. */
export const withCodes = (request: RequestText, answer: string) =>
  request.leading +
  markedPauses(request, answer).replace(
    placeholder,
    (found, n: string) => request.codes[Number(n) - 1] ?? found,
  ) +
  request.trailing;
