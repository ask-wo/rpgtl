import type { Entry, GlossaryTerm } from "@rpgtl/contracts";
import { characterAliases, nameParts, shortNameTranslations } from "./shortNames.ts";
import { termKind } from "./guesses.ts";

interface TextSearch {
  readonly sources: ReadonlyArray<string>;
  /** The entries, by index, that contain each pair of characters; built on the first search. */
  pairs?: Map<string, ReadonlyArray<number>>;
  readonly uses: Map<string, ReadonlyArray<string>>;
  /** The last order and its glossary, so the same glossary keeps the same order. */
  order?: { readonly glossary: ReadonlyArray<GlossaryTerm>; readonly order: ReadonlyArray<number> };
}

// Kept while the entries' sources stay the same: a run's every save gives a new entries list, and
// searching all of a large game's entries for each of its thousands of terms takes seconds.
let textSearch: TextSearch = { sources: [], uses: new Map() };

function pairsIn(sources: ReadonlyArray<string>) {
  const pairs = new Map<string, Array<number>>();
  sources.forEach((source, index) => {
    for (let at = 0; at + 1 < source.length; at++) {
      const pair = source.slice(at, at + 2);
      const found = pairs.get(pair);
      if (found === undefined) pairs.set(pair, [index]);
      else if (found.at(-1) !== index) found.push(index);
    }
  });
  return pairs;
}

/** Finds the ids of the entries containing a text. */
function textFinder(entries: ReadonlyArray<Entry>) {
  const { sources } = textSearch;
  if (
    sources.length !== entries.length ||
    entries.some((entry, index) => entry.source !== sources[index])
  )
    textSearch = { sources: entries.map((entry) => entry.source), uses: new Map() };
  const search = textSearch;
  const candidates = (text: string): ReadonlyArray<number> => {
    if (text.length < 2) return search.sources.map((_, index) => index);
    search.pairs ??= pairsIn(search.sources);
    let fewest: ReadonlyArray<number> | undefined;
    for (let at = 0; at + 1 < text.length; at++) {
      const found = search.pairs.get(text.slice(at, at + 2)) ?? [];
      if (fewest === undefined || found.length < fewest.length) fewest = found;
    }
    return fewest ?? [];
  };
  return (text: string) => {
    let found = search.uses.get(text);
    if (!found) {
      found = candidates(text)
        .filter((index) => search.sources[index]?.includes(text))
        .map((index) => entries[index]?.id ?? "");
      search.uses.set(text, found);
    }
    return found;
  };
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
  const entriesWith = textFinder(entries);
  if (textSearch.order?.glossary === glossary) return textSearch.order.order;
  const uses = glossary.map((term) => {
    const texts = termTexts(term, shortNames, aliases);
    if (texts.length < 2) return texts[0] === undefined ? 0 : entriesWith(texts[0]).length;
    return new Set(texts.flatMap((text) => entriesWith(text))).size;
  });
  const order = glossary.map((term, index) => ({
    index,
    hasSource: Number(!!term.source.trim()),
    kind: kindOrder[termKind(term)],
    uses: uses[index] ?? 0,
  }));
  const sorted = order
    .toSorted((a, b) => a.hasSource - b.hasSource || a.kind - b.kind || b.uses - a.uses)
    .map(({ index }) => index);
  textSearch.order = { glossary, order: sorted };
  return sorted;
}
