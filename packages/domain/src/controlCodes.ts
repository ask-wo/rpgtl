// RPG Maker escape codes such as \C[2], \n<Name>, \! and %1 placeholders, and the `#{}` code
// that an XP game's Ruby scripts put into their text.
// A code split by a line break, as an XP event script may write `\C` at a line's end and `[0]`
// at the next one's start, is kept whole: a game's message script may drop the line break.
export const controlCodePattern =
  /\\(?:[A-Za-z]+(?:\[[^\]]*\]|<[^>]*>|\n\[\d+\])|[A-Za-z]+|[{}$.|!><^\\])|%\d+|#\{[^{}]*\}/g;
export const speakerTagPattern = /\\n[a-z]*<([^>]*)>/gi;

export const speakerTagName = (text: string) => [...text.matchAll(speakerTagPattern)][0]?.[1];

/** The text without speaker tags and control codes, its spaces collapsed, for comparing texts. */
export const plainText = (text: string) =>
  text.replace(speakerTagPattern, "").replace(controlCodePattern, "").replace(/\s+/g, " ").trim();

// A backslash that starts no control code (such as before "！") is not shown by the engine, so it
// is not sent either. Codes win where both match.
export const codeOrBackslash = new RegExp(`${controlCodePattern.source}|\\\\`, "g");

/** The text as a message shows it, for requests: no control codes and no lone backslashes. */
export const shownText = (text: string) => text.replace(codeOrBackslash, "");

/**
 * The text without the escape codes a message window draws nothing for, such as `\C[14]`, for
 * measuring its width. Placeholders such as `%1` stay.
 */
export const measuredText = (text: string) =>
  text.replace(/\\[A-Za-z]+(\[[^\]]*\])?|\\[{}\\$.|!><^]/g, "");

/** Pauses (`\.`, `\|`, `\!`) only wait for time or a key press, so a translation may have more or fewer. */
export const isPauseCode = (code: string) => /^\\[.|!]$/.test(code);
/** Colors (`\C[n]`) only change how text looks, so a translation may drop them. */
export const isColorCode = (code: string) => /^\\C\[\d+\]$/i.test(code);

const controlCodes = (text: string) =>
  (text.match(controlCodePattern) ?? [])
    .filter((code) => !isPauseCode(code) && !isColorCode(code))
    .toSorted()
    .join("\0");
const speakerTags = (text: string) =>
  [...text.matchAll(speakerTagPattern)]
    .map((match) => match[0].replace(/<[^>]*>/, "<>"))
    .join("\0");
const otherControlCodes = (text: string) => text.replace(speakerTagPattern, "");

/**
 * Whether the translation has the source's control codes, in any order except for speaker tags;
 * the name in a speaker tag, pauses and colors may differ.
 */
export const keepsControlCodes = (source: string, translation: string) =>
  speakerTags(source) === speakerTags(translation) &&
  controlCodes(otherControlCodes(source)) === controlCodes(otherControlCodes(translation));
