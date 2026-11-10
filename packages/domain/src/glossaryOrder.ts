import type { Entry, GlossaryTerm } from "@rpgtl/contracts";
import { characterAliases, nameParts, shortNameTranslations } from "./shortNames.ts";
import { termKind } from "./guesses.ts";

// The entries containing each text, by the entries list; sources of entries never change.
const textUses = new WeakMap<ReadonlyArray<Entry>, Map<string, Entry[]>>();
function entriesWith(entries: ReadonlyArray<Entry>, text: string) {
  let uses = textUses.get(entries);
  if (!uses) textUses.set(entries, (uses = new Map()));
  let found = uses.get(text);
  if (!found) uses.set(text, (found = entries.filter((entry) => entry.source.includes(text))));
  return found;
}

const kindOrder = { character: 0, name: 1, word: 2 };

/**
 * The texts whose entries count as uses of a term: its original and, for a character, each part
 * of its dotted name that `shortNames` (from `shortNameTranslations`) gives English for and that
 * `aliases` (from `characterAliases`) gives to this character only, so two characters with one
 * family name don't count each other's lines.
 */
export function termTexts(
  term: GlossaryTerm,
  shortNames: ReadonlyMap<string, string>,
  aliases: ReadonlyMap<string, string>,
) {
  const source = term.source.trim();
  if (!source) return [];
  const parts =
    termKind(term) === "character"
      ? nameParts(source).filter((part) => shortNames.has(part) && aliases.get(part) === source)
      : [];
  return [source, ...parts];
}

/**
 * Glossary positions with new terms first, then characters, names and words, each by how many
 * entries use them. A character also counts the entries with a short name the translator knows.
 */
export function glossaryOrder(
  glossary: ReadonlyArray<GlossaryTerm>,
  entries: ReadonlyArray<Entry>,
) {
  const shortNames = shortNameTranslations(glossary);
  const aliases = characterAliases(glossary);
  const uses = glossary.map((term) => {
    const texts = termTexts(term, shortNames, aliases);
    if (texts.length < 2) return texts[0] === undefined ? 0 : entriesWith(entries, texts[0]).length;
    return new Set(texts.flatMap((text) => entriesWith(entries, text))).size;
  });
  const order = glossary.map((term, index) => ({
    index,
    hasSource: Number(!!term.source.trim()),
    kind: kindOrder[termKind(term)],
    uses: uses[index] ?? 0,
  }));
  return order
    .toSorted((a, b) => a.hasSource - b.hasSource || a.kind - b.kind || b.uses - a.uses)
    .map(({ index }) => index);
}
