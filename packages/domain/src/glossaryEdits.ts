import type { Catalog, Entry, GlossaryTerm, TermEdit } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { cleared } from "./catalog.ts";
import { entriesToClear } from "./shortNames.ts";
import { entryTranslation, mapInUse, termTranslation, termKind } from "./guesses.ts";

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
  return withoutStrayPronoun({
    source: edit.source,
    translation: translation === "" ? {} : withOwn(saved?.translation.guess, translation),
    kind: { guess: saved?.kind.guess ?? { value: "name" }, ...withOwn(undefined, edit.kind) },
    ...((pronoun.guess || pronoun.user) && { pronoun }),
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
  const renamed = new Map(
    old.flatMap((before) => {
      const after = next.find((other) => other.source === before.source);
      const to = after && termTranslation(after).trim();
      const from = termTranslation(before).trim();
      return to && to !== from ? [[before.source, { from, to }] as const] : [];
    }),
  );
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
  const glossary = edited.map((edit) => savedTerm(saved.get(edit.source), edit));
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
