import type { Catalog, Entry, GlossaryTerm, Pronoun } from "@rpgtl/contracts";
import { inUse, entryTranslation, termTranslation, termKind } from "./guesses.ts";

export const nameParts = (name: string) => name.split(/[·・•]/);

const characters = (text: string) => Array.from(text).length;

/**
 * Short forms of dotted names are usable only when they identify one name. Any part can be one:
 * Japanese names put the given name last (藤原·美咲), Western ones first (艾琳娜·莫顿).
 */
export function nameAliases(names: ReadonlyArray<string>) {
  const fullNames = new Set(names);
  const owners = new Map<string, Set<string>>();
  for (const name of names) {
    for (const alias of [name, ...nameParts(name)]) {
      if (characters(alias) < 2) continue;
      const owning = owners.get(alias);
      if (owning) owning.add(name);
      else owners.set(alias, new Set([name]));
    }
  }
  const aliases = new Map<string, string>();
  for (const [alias, candidates] of owners) {
    const [only] = candidates;
    if (fullNames.has(alias)) aliases.set(alias, alias);
    else if (candidates.size === 1 && only !== undefined) aliases.set(alias, only);
  }
  return aliases;
}

/** `nameAliases` of the glossary's characters: each name part that belongs to one character only. */
export const characterAliases = (glossary: ReadonlyArray<GlossaryTerm>) =>
  nameAliases(glossary.filter((t) => termKind(t) === "character").map((t) => t.source.trim()));

/** English for the final part of a dotted name, allowing a title before the given name. */
export function shortNameTranslation(source: string, translation: string) {
  const parts = nameParts(source);
  const words = translation.trim().split(/\s+/);
  return parts.length > 1 && words.length >= parts.length ? words.at(-1) : undefined;
}

/**
 * English for each part of a dotted name. With as many words as parts, each part is the word in
 * its place, so 艾琳娜·莫顿 as Irena Morton makes 艾琳娜 Irena. With more words, only the last part
 * is sure, as a title may come before the given name; the others are guesses by their place.
 */
function partTranslations(source: string, translation: string) {
  const parts = nameParts(source);
  const words = translation.trim().split(/\s+/);
  return parts.map((part, index) => {
    const last = index === parts.length - 1;
    const sure =
      words.length === parts.length
        ? words[index]
        : last
          ? shortNameTranslation(source, translation)
          : undefined;
    const guess = !sure && !last && words.length > parts.length ? words[index] : undefined;
    return { part, sure, guess };
  });
}

/**
 * English for the part of a dotted name the game's text uses on its own most, which is usually the
 * given name: 艾琳娜 of 艾琳娜·莫顿 makes Irena Morton Irena. Without such uses, the last part.
 */
export function givenNameTranslation(
  source: string,
  translation: string,
  entries: ReadonlyArray<Pick<Entry, "source">>,
) {
  const texts = entries.map((entry) => entry.source.split(source).join("\n"));
  let best: { sure: string; uses: number } | undefined;
  for (const { part, sure } of partTranslations(source, translation)) {
    if (!sure || characters(part) < 2) continue;
    const uses = texts.filter((text) => text.includes(part)).length;
    if (uses && uses > (best?.uses ?? 0)) best = { sure, uses };
  }
  return best?.sure ?? shortNameTranslation(source, translation);
}

/**
 * Shared short names are usable when every candidate gives them the same translation. A guess
 * by place agrees or blocks, but doesn't decide.
 */
export function shortNameTranslations(glossary: ReadonlyArray<GlossaryTerm>) {
  const candidates = new Map<string, { sure: Set<string | undefined>; guesses: Set<string> }>();
  for (const term of glossary) {
    if (termKind(term) !== "character") continue;
    const source = term.source.trim();
    if (nameParts(source).length < 2) continue;
    for (const { part, sure, guess } of partTranslations(source, termTranslation(term))) {
      if (characters(part) < 2) continue;
      let candidate = candidates.get(part);
      if (!candidate) candidates.set(part, (candidate = { sure: new Set(), guesses: new Set() }));
      if (guess) candidate.guesses.add(guess);
      else candidate.sure.add(sure);
    }
  }
  const translations = new Map<string, string>();
  for (const [source, { sure, guesses }] of candidates) {
    const explicit = glossary.find((term) => term.source.trim() === source);
    const agreed = sure.size === 1 ? [...sure][0] : undefined;
    const translation = explicit
      ? termTranslation(explicit).trim()
      : agreed && [...guesses].every((guess) => guess === agreed)
        ? agreed
        : undefined;
    if (translation) translations.set(source, translation);
  }
  return translations;
}

/** Whether text uses a term as a whole word, so "marina" doesn't count as using "Rina". */
const usesWord = (text: string, term: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${RegExp.escape(term)}(?![\\p{L}\\p{N}])`, "iu").test(text);

/**
 * Translated entries that contain a glossary term, for translating them again: its name, or a short
 * form of it that no other character shares. With `mismatchesOnly`, only those that don't use the
 * term's English, counting shared short forms too, since their English is the same for both.
 */
export function entriesToClear<E extends Entry>(
  catalog: { readonly entries: ReadonlyArray<E>; readonly glossary: Catalog["glossary"] },
  term: GlossaryTerm,
  mismatchesOnly: boolean,
) {
  const key = term.source.trim();
  const english = termTranslation(term).trim();
  if (!key) return [];
  // Entries that call a dotted name by one part alone, such as 美咲 for 藤原·美咲.
  const translations =
    termKind(term) === "character" ? shortNameTranslations(catalog.glossary) : undefined;
  const owners = characterAliases(catalog.glossary);
  const shorts =
    nameParts(key).length < 2
      ? []
      : nameParts(key).flatMap((part) => {
          const short = translations?.get(part);
          return short && (mismatchesOnly || owners.get(part) === key)
            ? [{ key: part, english: short }]
            : [];
        });
  return catalog.entries.filter((e) => {
    if (!entryTranslation(e)) return false;
    const match = e.source.includes(key)
      ? { english }
      : shorts.find((s) => e.source.includes(s.key));
    if (!match) return false;
    return !(mismatchesOnly && match.english && usesWord(entryTranslation(e), match.english));
  });
}

/**
 * Whether a pronoun is sent to the translator: she or he, unless the model chose it and the text's
 * clues lean the other way, which leaves it to the user.
 */
export const sentPronoun = (pronoun: Pronoun | undefined) => {
  const value = pronoun && inUse(pronoun);
  return (value === "she" || value === "he") && !(pronoun && doubted(pronoun));
};

/** Whether the model's pronoun is in use while the text's clues lean the other way. */
export const doubted = ({ guess, user }: Pronoun) =>
  user === undefined &&
  guess?.run !== undefined &&
  (guess.value === "she"
    ? (guess.he ?? 0) > (guess.she ?? 0)
    : guess.value === "he" && (guess.she ?? 0) > (guess.he ?? 0));
