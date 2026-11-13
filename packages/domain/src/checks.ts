import type {
  Catalog,
  CheckName,
  Engine,
  Entry,
  Finding,
  Findings,
  GlossaryTerm,
  SourceLanguage,
} from "@rpgtl/contracts";
import { controlCodePattern, plainText, speakerTagPattern } from "./controlCodes.ts";
import { keepsTags, withoutTags } from "./engines/xp/databaseTags.ts";
import { isNameEntry, isSpeakerNameEntry } from "./nameEntries.ts";
import { hasTerm } from "./termMatch.ts";
import { entryTranslation, termTranslation, termKind } from "./guesses.ts";
import { gameLanguage } from "./language.ts";
import type { Placed } from "./location.ts";

// Game dialogue apologizes and refuses too ("I'm sorry, but", "I can't help it"), so only
// phrases about the request itself count.
export const refusalPattern =
  /\b(?:as an AI|I can(?:no|')t (?:assist|translate|comply)|I (?:won't|will not) (?:assist|translate)|unable to (?:assist|translate))\b/i;

// Models sometimes end an answer with the id of the next entry on a line of its own.
const trailingNumber = /\s*\n\s*\d+\s*$/;
// `trailingNumber`'s leading `\s*` makes `test()` retry from every space; `replace` needs it to
// remove that whitespace.
const endsWithNumberLine = /\n\s*\d+\s*$/;
export const endsWithStrayNumber = (source: string, translation: string) =>
  endsWithNumberLine.test(translation) && !endsWithNumberLine.test(source);
/** The translation without a number a model added on a last line of its own. */
export const withoutStrayNumber = (source: string, translation: string) =>
  endsWithStrayNumber(source, translation) ? translation.replace(trailingNumber, "") : translation;

/**
 * Chinese, Japanese or Korean writing; punctuation such as ・ and 「」 doesn't count, nor 〇, which
 * Unicode files as Han but games use as a circle mark (〇/✕).
 */
export const sourceScript =
  /(?!〇)[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const quotedCharacter = /[「『](.)[」』]/gu;
const quotedInEnglish = /["“'‘「『](.)["”'’」』]/gu;
const shootingStar = /[★☆]ミ/g;

/**
 * Whether the translation still has source writing in it. A single quoted character of the source
 * may stay quoted, since a line about the writing itself (「ァ」と「ア」) can't translate it, and so
 * may the ミ of ★ミ, which draws a shooting star's tail.
 */
export function sourceLeft(source: string, translation: string) {
  const quoted = new Set(Array.from(source.matchAll(quotedCharacter), (match) => match[1]));
  return sourceScript.test(
    translation
      .replace(shootingStar, "")
      .replace(quotedInEnglish, (all, character: string) => (quoted.has(character) ? "" : all)),
  );
}
const sourceCharacters = new RegExp(sourceScript.source, "gu");
const wideCharacters = /\p{Script=Han}/gu;
const length = (text: string) => Array.from(text).length;
const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

// Credits lines such as 画师:青木流水 keep the names as written: "Artist: 青木流水".
const keptCreditNames = (source: string, translation: string) => {
  const names = /[:：](.+)$/s.exec(source)?.[1]?.trim();
  return !!names && translation.trimEnd().endsWith(names);
};

const repeatsSpeaker = (translation: string) => {
  const tag = /^\\n[a-z]*<([^>]+)>/i.exec(translation);
  const name = tag?.[1];
  if (!tag || !name) return false;
  const text = translation.slice(tag[0].length).replace(controlCodePattern, "").trimStart();
  return text.toLowerCase().startsWith(`${name.toLowerCase()}:`);
};

// Far longer than the source, or fewer letters than the source's weight in characters (for example
// only the speaker's name), means the answer belongs to another entry or lost part of it. A Chinese
// character weighs one; kana and Hangul, which spell sounds, weigh half (ありがとう → Thanks).
function lengthUnlike(source: string, translation: string) {
  const sourceText = plainText(source);
  const text = plainText(translation);
  const wide = count(sourceText, wideCharacters);
  const weight = wide + (count(sourceText, sourceCharacters) - wide) / 2;
  const letters = count(text, /\p{L}/gu);
  return length(text) > 40 + 5 * length(sourceText) || (weight >= 6 && letters < weight);
}

// "Body" counts; "HP" doesn't, since it is not capitalised only at its first letter.
export const capitalisedWord = (word: string) =>
  /^\p{Lu}/u.test(word) && /\p{Ll}/u.test(word) && !/\p{Lu}/u.test(word.slice(1));
const wordPattern = (english: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${RegExp.escape(english)}(?![\\p{L}\\p{N}])`, "gu");

// Most longer words capitalised, as in a map name such as "Return to the Old Lighthouse".
function titleCase(text: string) {
  const words = text.match(/\p{L}{4,}/gu) ?? [];
  return words.filter((word) => /^\p{Lu}/u.test(word)).length >= 0.7 * words.length;
}

// Only a lowercase word or a possessive right before it counts, as in "the Teacher" or "Her Body":
// labels and titles such as "[Magic Equipment]" or "Slot  Top", and names used to address
// someone, are capitalised.
const before = /(?<![\p{L}'])(?:\p{Ll}[\p{L}']*|her|his|my|your|our|their|its|this|that|a|an) $/iu;
export function capitalisedMidSentence(translation: string, english: string) {
  const text = plainText(translation);
  return (
    !titleCase(text) &&
    [...text.matchAll(wordPattern(english))].some((match) =>
      before.test(text.slice(0, match.index)),
    )
  );
}

const she = /\b(?:she|her|hers|herself)\b/gi;
const he = /\b(?:he|him|his|himself)\b/gi;

function pronounUnlike(source: string, translation: string) {
  const text = plainText(translation);
  const [shes, hes] = [count(text, she), count(text, he)];
  // 他们 (they), 他人 and 其他 (others) say nothing about one person.
  const his = source.replace(/他们|他人|其他|他俩/g, "").includes("他");
  if (source.includes("她") && !his && hes && !shes) return "她 but he";
  if (his && !source.includes("她") && shes && !hes) return "他 but she";
  return undefined;
}

/**
 * The terms that may be in a text, in their order: those starting with two characters the text has
 * in a row, or with one for a term of one character, so a text isn't searched for every term of
 * the glossary.
 */
function termLookup(terms: ReadonlyArray<GlossaryTerm>) {
  const byStart = new Map<string, number[]>();
  terms.forEach((term, index) => {
    const start = Array.from(term.source).slice(0, 2).join("");
    const known = byStart.get(start);
    if (known) known.push(index);
    else byStart.set(start, [index]);
  });
  return (text: string) => {
    const characters = Array.from(text);
    const near = new Set<number>();
    characters.forEach((character, at) => {
      for (const start of [character, character + (characters[at + 1] ?? "")])
        for (const index of byStart.get(start) ?? []) near.add(index);
    });
    return [...near].toSorted((a, b) => a - b).flatMap((index) => terms[index] ?? []);
  };
}

/** The glossary terms in a text, longest first, each counted once where a longer one covers it. */
function termsIn(text: string, terms: ReadonlyArray<GlossaryTerm>) {
  let rest = text;
  const found: GlossaryTerm[] = [];
  for (const term of terms)
    if (hasTerm(rest, term.source)) {
      found.push(term);
      rest = rest.split(term.source).join("\0");
    }
  return found;
}

// A name may be shortened to one of its parts, as in "Ruoxi" for Lin Ruoxi.
const nameParts = (english: string) => [
  english,
  ...english.split(/[\s·・.-]+/).filter((part) => part.length > 1),
];
// A name such as "Transform" may also come back as "transforming".
const mentions = (text: string, english: string) =>
  nameParts(english).some((part) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${RegExp.escape(part)}`, "iu").test(text),
  );

export function translationChecks(
  glossary: ReadonlyArray<GlossaryTerm>,
  language: SourceLanguage,
  engine: Engine,
) {
  const terms = glossary
    .filter((term) => term.source.trim() && termTranslation(term).trim())
    .toSorted((a, b) => b.source.length - a.source.length);
  // A one-character term such as 月 is often part of an ordinary word.
  const names = terms.filter(
    (term) =>
      (termKind(term) === "character" || termKind(term) === "name") &&
      length(term.source.trim()) > 1 &&
      !sourceScript.test(termTranslation(term)),
  );
  const nearTerms = termLookup(terms);
  const isName = new Set(names);
  return (entry: Pick<Entry, "source"> & Placed, written: string): Finding[] => {
    if (!written) return [];
    const tags = keepsTags(engine, entry);
    const source = tags ? withoutTags(entry.source) : entry.source;
    const translation = tags ? withoutTags(written) : written;
    const findings: Finding[] = [];
    const add = (check: CheckName, detail?: string) =>
      findings.push(detail === undefined ? { check } : { check, detail });
    if (
      sourceLeft(source, translation.replace(speakerTagPattern, "")) &&
      !keptCreditNames(source, translation)
    )
      add("source text left");
    if (endsWithStrayNumber(source, translation)) add("number added on a last line");
    if (refusalPattern.test(translation)) add("refusal");
    if (isNameEntry(entry) || isSpeakerNameEntry(entry)) return findings;
    if (repeatsSpeaker(translation)) add("speaker name repeated");
    if (lengthUnlike(source, translation)) add("length unlike the source");
    const sourceText = plainText(source);
    const text = plainText(translation);
    for (const term of termsIn(sourceText, nearTerms(sourceText)).filter((found) =>
      isName.has(found),
    ))
      if (!mentions(text, termTranslation(term)))
        add("glossary name missing", `${term.source} → ${termTranslation(term)}`);
    // In Japanese, 他 means other (他の人).
    const pronoun = language === "chinese" ? pronounUnlike(sourceText, translation) : undefined;
    if (pronoun) add("pronoun unlike the source", pronoun);
    return findings;
  };
}

/** The findings of every translated entry that has any, by entry id. */
export function catalogFindings(
  catalog: Pick<Catalog, "entries" | "glossary" | "language" | "game">,
): Findings {
  const check = translationChecks(catalog.glossary, gameLanguage(catalog), catalog.game.engine);
  const found: Record<string, Finding[]> = {};
  for (const entry of catalog.entries) {
    const findings = check(entry, entryTranslation(entry));
    if (findings.length) found[entry.id] = findings;
  }
  return found;
}
