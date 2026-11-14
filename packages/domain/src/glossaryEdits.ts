import type { Catalog, Entry, GlossaryTerm, TermEdit } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { cleared } from "./catalog.ts";
import { wordPattern } from "./checks.ts";
import { hasTerm } from "./termMatch.ts";
import { entriesToClear } from "./shortNames.ts";
import { entryTranslation, inUse, mapInUse, termTranslation, termKind } from "./guesses.ts";

/** A glossary that lists the same source twice. */
export class GlossaryTermRepeated extends Schema.TaggedError<GlossaryTermRepeated>()(
  "GlossaryTermRepeated",
  { source: Schema.String },
) {
  override get message() {
    return `${this.source} is in the glossary twice. Each term can be listed only once.`;
  }
}

/** The first source the glossary lists twice. */
export const repeatedSource = (glossary: ReadonlyArray<Pick<GlossaryTerm, "source">>) => {
  const seen = new Set<string>();
  for (const { source } of glossary) {
    if (seen.has(source)) return source;
    seen.add(source);
  }
  return undefined;
};

/** Only characters keep a pronoun. */
export const withoutStrayPronoun = ({ pronoun, ...term }: GlossaryTerm): GlossaryTerm => ({
  ...term,
  ...(termKind(term) === "character" && pronoun && { pronoun }),
});

/** The user's own values of a term, as the Glossary page saves them. */
export const termEdit = ({ source, translation, kind, pronoun }: GlossaryTerm): TermEdit => ({
  source,
  ...(translation.user !== undefined && { translation: translation.user }),
  ...(kind.user !== undefined && { kind: kind.user }),
  ...(pronoun?.user !== undefined && { pronoun: pronoun.user }),
});

const withOwn = <A, G>(guess: G | undefined, user: A | undefined) => ({
  ...(guess !== undefined && { guess }),
  ...(user !== undefined && { user }),
});

/**
 * The term the user saved, with the guesses of `saved`, the term of its source before. Empty
 * English leaves the term without any. A term the user adds is a name, as the rules guess until a
 * run's model sorts it.
 */
export function savedTerm(saved: GlossaryTerm | undefined, edit: TermEdit): GlossaryTerm {
  const translation = edit.translation?.trim();
  const pronoun = withOwn(saved?.pronoun?.guess, edit.pronoun);
  const english = translation === "" ? {} : withOwn(saved?.translation.guess, translation);
  const previous =
    translation === "" && saved ? termTranslation(saved) || saved.previous : saved?.previous;
  return withoutStrayPronoun({
    source: edit.source,
    translation: english,
    kind: { guess: saved?.kind.guess ?? { value: "name" }, ...withOwn(undefined, edit.kind) },
    ...((pronoun.guess || pronoun.user) && { pronoun }),
    ...(previous !== undefined && previous !== inUse(english) && { previous }),
  });
}

/** The terms whose English changed from `old` to `next` to other English, by source. */
const renames = (old: ReadonlyArray<GlossaryTerm>, next: ReadonlyArray<GlossaryTerm>) => {
  const after = new Map(next.map((term) => [term.source, termTranslation(term).trim()]));
  return new Map(
    old.flatMap((before) => {
      const to = after.get(before.source);
      const from = termTranslation(before).trim();
      return to && to !== from
        ? [[before.source, { from, to, previous: before.previous }] as const]
        : [];
    }),
  );
};

/**
 * The glossary `next` with each term that contains a renamed term's source, such as an item
 * named after a character, following the rename in English a run or rule gave. A term typed
 * again after clearing renames from the English it had before.
 */
export function withRenamesFollowed(
  old: ReadonlyArray<GlossaryTerm>,
  next: ReadonlyArray<GlossaryTerm>,
) {
  const renamed = [...renames(old, next)];
  if (!renamed.length) return next;
  return next.map((term) => {
    if (term.translation.user !== undefined) return term;
    const translation = renamed.reduce((english, [source, { from, to, previous }]) => {
      const was = from || previous;
      return was && source !== term.source && hasTerm(term.source, source)
        ? mapInUse(english, (value) => value.replace(wordPattern(was), () => to))
        : english;
    }, term.translation);
    return translation === term.translation ? term : { ...term, translation };
  });
}

/**
 * The English an entry gets when the glossary changes from `old` to `next`: an entry that is
 * exactly a term whose English changed to another one follows it.
 */
export function renamedTranslation(
  old: ReadonlyArray<GlossaryTerm>,
  next: ReadonlyArray<GlossaryTerm>,
) {
  const renamed = renames(old, next);
  return <T extends Pick<Entry, "source" | "translation">>(entry: T): T => {
    const term = renamed.get(entry.source.trim());
    return term && entryTranslation(entry).trim() === term.from
      ? { ...entry, translation: mapInUse(entry.translation, () => term.to) }
      : entry;
  };
}

/** The catalog with the glossary the user edited, as the Glossary page saves it. */
export function withGlossary(
  current: Catalog,
  edited: ReadonlyArray<TermEdit>,
): Result.Result<Catalog, GlossaryTermRepeated> {
  const repeated = repeatedSource(edited);
  if (repeated !== undefined) return Result.fail(new GlossaryTermRepeated({ source: repeated }));
  const saved = new Map(current.glossary.map((term) => [term.source, term]));
  const glossary = withRenamesFollowed(
    current.glossary,
    edited.map((edit) => savedTerm(saved.get(edit.source), edit)),
  );
  return Result.succeed({
    ...current,
    entries: current.entries.map(renamedTranslation(current.glossary, glossary)),
    glossary,
  });
}

/**
 * The catalog with the translations cleared that contain one of the terms with these sources, so the
 * next run translates them again. With `mismatchesOnly`, only those that don't use its English, and
 * a term without English yet clears nothing.
 */
export function withTermLinesCleared(
  catalog: Catalog,
  sources: ReadonlyArray<string>,
  mismatchesOnly: boolean,
) {
  const wanted = new Set(sources);
  const ids = new Set(
    catalog.glossary
      .filter(
        (term) => wanted.has(term.source) && (!mismatchesOnly || termTranslation(term).trim()),
      )
      .flatMap((term) => entriesToClear(catalog, term, mismatchesOnly).map((entry) => entry.id)),
  );
  return {
    cleared: ids.size,
    catalog: {
      ...catalog,
      entries: catalog.entries.map((entry) => (ids.has(entry.id) ? cleared(entry) : entry)),
    } satisfies Catalog,
  };
}
