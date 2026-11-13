import type { Entry, GlossaryTerm, Pronoun, SourceLanguage } from "@rpgtl/contracts";
import {
  controlCodePattern,
  isPauseCode,
  speakerTagName,
  speakerTagPattern,
} from "./controlCodes.ts";
import { isMessage, isSettingText } from "./location.ts";
import { firstLineSpeaker } from "./requestText.ts";
import { showTextSpeakers } from "./reuse.ts";
import { nameAliases } from "./shortNames.ts";
import { hasTerm, termIndex } from "./termMatch.ts";
import { termKind } from "./guesses.ts";

/** The words of a language that show a character's gender. */
interface GenderWords {
  /** The first `she` or `he` group it matches is a pronoun for one person. */
  readonly pronoun: RegExp;
  /** Words right before a name or after it, such as titles. */
  readonly femaleBefore: ReadonlyArray<string>;
  readonly femaleAfter: ReadonlyArray<string>;
  readonly maleBefore: ReadonlyArray<string>;
  readonly maleAfter: ReadonlyArray<string>;
  /** Words only women or only men say, such as ways of saying I. */
  readonly femaleSays: ReadonlyArray<string>;
  readonly maleSays: ReadonlyArray<string>;
  readonly sentenceEnd: RegExp;
}

export const genderWords: Record<SourceLanguage, GenderWords> = {
  chinese: {
    pronoun: /(?<she>她)|(?<he>他)/,
    femaleBefore: ["少女", "女孩", "女生", "女警", "女士"],
    femaleAfter: ["姐姐", "姐", "妹妹", "妹", "小姐", "阿姨"],
    maleBefore: ["男孩", "男生", "少年"],
    maleAfter: ["哥哥", "哥", "弟弟", "弟", "先生", "少爷"],
    femaleSays: ["本小姐", "老娘", "本姑娘"],
    maleSays: ["老子", "本少爷", "本大爷"],
    sentenceEnd: /[。！？!?…\n]+/,
  },
  japanese: {
    // 彼ら and 彼等 are they, 彼方 and 彼岸 the far side.
    pronoun: /(?<she>彼女)|(?<he>彼)(?![ら等方岸])/,
    femaleBefore: ["少女"],
    femaleAfter: ["姉ちゃん", "姉さん", "姉様", "姉", "嬢", "姫"],
    maleBefore: ["少年"],
    maleAfter: ["兄ちゃん", "兄さん", "兄様", "兄", "くん"],
    // おれ and わし in kana are also parts of other words (たおれる, こわし).
    femaleSays: ["あたし", "わらわ"],
    maleSays: ["俺", "オレ", "儂"],
    sentenceEnd: /[。！？!?…\n]+/,
  },
  korean: {
    // 그 is also that, as in 그래 or 그런; before these particles it is he.
    pronoun: /(?<!\p{Script=Hangul})(?:(?<she>그녀)|(?<he>그)(?=는|가|의|를|에게))/u,
    femaleBefore: ["소녀"],
    femaleAfter: ["누나", "언니", "아줌마", "할머니", "아가씨"],
    maleBefore: ["소년"],
    maleAfter: ["오빠", "형", "아저씨", "할아버지", "도련님"],
    // What a woman calls an older man and an older woman, and what a man calls an older woman; 형,
    // which a man calls an older man, is also part of many words (인형, 지형).
    femaleSays: ["오빠", "언니"],
    maleSays: ["누나"],
    sentenceEnd: /[。！？!?….\n]+/,
  },
};

const minimumClues = 3;
const minimumAgreement = 0.8;

export interface Clues {
  she: number;
  he: number;
}

/** Splits a message into sentences: control codes are dropped, pause codes and line breaks end one. */
function sentences(source: string, words: GenderWords) {
  const text = source
    .replace(speakerTagPattern, "")
    .replace(controlCodePattern, (code) => (isPauseCode(code) ? "\n" : ""));
  return text
    .split(words.sentenceEnd)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Where each glossary name stands in the sentence; the longest name wins where names overlap. */
function mentions(sentence: string, names: ReadonlyArray<string>) {
  const found: { name: string; start: number; end: number }[] = [];
  const taken = Array.from({ length: sentence.length }, () => false);
  for (const name of names) {
    for (let at = termIndex(sentence, name); at >= 0; at = termIndex(sentence, name, at + 1)) {
      const end = at + name.length;
      if (taken.slice(at, end).some(Boolean)) continue;
      taken.fill(true, at, end);
      found.push({ name, start: at, end });
    }
  }
  return found.toSorted((a, b) => a.start - b.start);
}

const messageSpeaker = (entry: Entry, names: ReadonlySet<string>) =>
  isMessage(entry) ? firstLineSpeaker(entry.source, (name) => names.has(name)) : undefined;

/** A message's text without a speaker's name alone on its first line. */
const withoutSpeakerLine = (entry: Entry, names: ReadonlySet<string>) =>
  messageSpeaker(entry, names) === undefined
    ? entry.source
    : entry.source.slice(entry.source.indexOf("\n") + 1);

const speakerIn = (
  entry: Entry,
  speakerOf: (entry: Entry) => string | undefined,
  names: ReadonlySet<string>,
) => speakerTagName(entry.source) ?? messageSpeaker(entry, names) ?? speakerOf(entry);

function firstPronoun(text: string, words: GenderWords) {
  const found = words.pronoun.exec(text);
  if (!found) return undefined;
  const pronoun: keyof Clues = found.groups?.she === undefined ? "he" : "she";
  return { pronoun, at: found.index };
}

/**
 * Counts the clues for each name from the game's text. System.json terms and plugin settings are
 * not searched.
 */
export function collectClues(
  entries: ReadonlyArray<Entry>,
  names: ReadonlyArray<string>,
  language: SourceLanguage,
) {
  const words = genderWords[language];
  const clues = new Map<string, Clues>(names.map((name) => [name, { she: 0, he: 0 }]));
  const aliases = nameAliases(names);
  const ordered = [...aliases.keys()].toSorted((a, b) => b.length - a.length);
  const speakerOf = showTextSpeakers(entries);
  const known = new Set(names);
  for (const entry of entries) {
    if (isSettingText(entry)) continue;
    const speaker = speakerIn(entry, speakerOf, known);
    const spoken = speaker === undefined ? undefined : clues.get(speaker.trim());
    if (spoken) {
      if (words.femaleSays.some((word) => entry.source.includes(word))) spoken.she++;
      else if (words.maleSays.some((word) => entry.source.includes(word))) spoken.he++;
    }
    let previous: Clues[] = [];
    for (const sentence of sentences(withoutSpeakerLine(entry, known), words)) {
      const found = mentions(sentence, ordered).flatMap((mention) => {
        const name = aliases.get(mention.name);
        const counts = name === undefined ? undefined : clues.get(name);
        return counts ? [{ ...mention, counts }] : [];
      });
      const opening = firstPronoun(sentence, words);
      const [only] = previous;
      if (opening?.at === 0 && only && previous.length === 1) only[opening.pronoun]++;
      for (const [index, mention] of found.entries()) {
        const { counts } = mention;
        const next = found[index + 1];
        const limit = next ? next.start : sentence.length;
        const after = firstPronoun(sentence.slice(mention.end, limit), words);
        if (after) counts[after.pronoun]++;
        // Korean writes a space between a name and its title.
        const before = sentence.slice(0, mention.start).trimEnd();
        const behind = sentence.slice(mention.end).trimStart();
        if (
          words.femaleBefore.some((word) => before.endsWith(word)) ||
          words.femaleAfter.some((word) => behind.startsWith(word))
        )
          counts.she++;
        else if (
          words.maleBefore.some((word) => before.endsWith(word)) ||
          words.maleAfter.some((word) => behind.startsWith(word))
        )
          counts.he++;
      }
      previous = [...new Set(found.map((mention) => mention.counts))];
    }
  }
  return clues;
}

export function pronounFromClues({ she, he }: Clues): NonNullable<Pronoun["guess"]> {
  const total = she + he;
  const value =
    total < minimumClues
      ? "unknown"
      : she / total >= minimumAgreement
        ? "she"
        : he / total >= minimumAgreement
          ? "he"
          : "unknown";
  return { value, she, he };
}

const maxMentions = 20;
const maxSpoken = 10;
const maxCharacters = 2400;
const maxLineLength = 100;

/** Up to `count` entries spread evenly over the list. */
const spread = <T>(items: ReadonlyArray<T>, count: number) => {
  const length = Math.min(count, items.length);
  return Array.from({ length }, (_, i) => items[Math.floor((i * items.length) / length)]).filter(
    (item) => item !== undefined,
  );
};

/**
 * For a character's name, up to 20 lines that mention the character and 10 the character says,
 * spread over the game, and how many entries do either.
 */
export function linesAbout(
  entries: ReadonlyArray<Entry>,
  glossary: ReadonlyArray<GlossaryTerm>,
  language: SourceLanguage,
) {
  const words = genderWords[language];
  const terms = new Set(glossary.map((term) => term.source.trim()));
  const characters = glossary
    .filter((term) => termKind(term) === "character")
    .map((term) => term.source.trim());
  const known = new Set(characters);
  const aliases = [...nameAliases(characters)];
  const speakerOf = showTextSpeakers(entries);
  // Speaker names are left out, so a line that only names its speaker counts as said.
  const text = entries
    .filter((entry) => !isSettingText(entry) && !terms.has(entry.source.trim()))
    .map((entry) => ({
      line: sentences(withoutSpeakerLine(entry, known), words).join(" "),
      speaker: speakerIn(entry, speakerOf, known)?.trim(),
    }));
  return (name: string) => {
    const own = aliases.filter(([, owner]) => owner === name).map(([alias]) => alias);
    const mentioning = text.filter(({ line }) => own.some((alias) => hasTerm(line, alias)));
    const mentioned = new Set(mentioning);
    const spoken = text.filter((item) => item.speaker === name && !mentioned.has(item));
    const lines: string[] = [];
    let size = 0;
    const add = (line: string) => {
      if (size + line.length > maxCharacters) return;
      size += line.length;
      lines.push(line);
    };
    for (const { line } of spread(mentioning, maxMentions)) {
      const firstMention = Math.min(
        ...own.map((alias) => termIndex(line, alias)).filter((at) => at >= 0),
      );
      const at = Math.max(
        0,
        (Number.isFinite(firstMention) ? firstMention : 0) - maxLineLength / 2,
      );
      add(line.slice(at, at + maxLineLength));
    }
    for (const { line } of spread(spoken, maxSpoken))
      add(`${name}: ${line.slice(0, maxLineLength)}`);
    return { lines, count: mentioning.length + spoken.length };
  };
}
