import type { GlossaryTerm } from "@rpgtl/contracts";
import type { PromptTerm, RequestEntry } from "./prompts.ts";
import { nameAliases, nameParts, sentPronoun, shortNameTranslations } from "./shortNames.ts";
import { matchingSounds } from "./sounds.ts";
import { hasTerm } from "./termMatch.ts";
import { termTranslation, termKind, termPronoun } from "./guesses.ts";

type Mentioned = Pick<RequestEntry, "speaker" | "text">;

const lowerOrdinaryWords = (translation: string) =>
  translation.replace(/\b\p{Lu}\p{Ll}+\b/gu, (word) => word.toLowerCase());

/** Whether entries mention a term: its source, a character's unique short name, or as speaker. */
function mentions(glossary: ReadonlyArray<GlossaryTerm>) {
  const aliasesByName = new Map<string, Array<string>>();
  const characters = glossary.filter((term) => termKind(term) === "character");
  for (const [alias, owner] of nameAliases(characters.map((term) => term.source))) {
    const aliases = aliasesByName.get(owner);
    if (aliases) aliases.push(alias);
    else aliasesByName.set(owner, [alias]);
  }
  return (entries: ReadonlyArray<Mentioned>, term: GlossaryTerm) =>
    entries.some(
      (entry) =>
        (termKind(term) === "character" && entry.speaker === termTranslation(term)) ||
        hasTerm(entry.text, term.source) ||
        (termKind(term) === "character" &&
          aliasesByName.get(term.source)?.some((alias) => hasTerm(entry.text, alias))),
    );
}

/**
 * The glossary terms and sound hints a request sends: terms of two or more characters the entries
 * mention, the short forms of dotted character names, and the sounds the entries spell. A word's
 * English goes lowercased, as it is written in a sentence.
 */
export function requestGlossary(
  glossary: ReadonlyArray<GlossaryTerm>,
  entries: ReadonlyArray<Mentioned>,
): ReadonlyArray<PromptTerm> {
  const mentioned = mentions(glossary);
  const shorts = shortNameTranslations(glossary);
  const terms = new Map<string, PromptTerm>();
  for (const term of glossary) {
    const mentionsShort =
      termKind(term) === "character" &&
      nameParts(term.source.trim()).some(
        (part) => shorts.has(part) && entries.some((entry) => entry.text.includes(part)),
      );
    if (Array.from(term.source).length >= 2 && (mentioned(entries, term) || mentionsShort))
      terms.set(term.source, {
        source: term.source,
        translation:
          termKind(term) === "word"
            ? lowerOrdinaryWords(termTranslation(term))
            : termTranslation(term),
      });
  }
  for (const [source, translation] of shorts)
    if (!terms.has(source) && entries.some((entry) => entry.text.includes(source)))
      terms.set(source, { source, translation });
  const sounds = matchingSounds(entries.map((entry) => entry.text)).filter(
    (sound) => !terms.has(sound.source),
  );
  return [...terms.values(), ...sounds];
}

/** The pronoun lines a request sends, for the characters the entries mention. */
export function requestPronouns(
  glossary: ReadonlyArray<GlossaryTerm>,
  entries: ReadonlyArray<Mentioned>,
): ReadonlyArray<string> {
  const mentioned = mentions(glossary);
  return glossary.flatMap((term) =>
    termKind(term) === "character" &&
    term.pronoun &&
    sentPronoun(term.pronoun) &&
    Array.from(term.source).length >= 2 &&
    mentioned(entries, term)
      ? [`${termTranslation(term)}: ${termPronoun(term) === "she" ? "she/her" : "he/him"}`]
      : [],
  );
}
