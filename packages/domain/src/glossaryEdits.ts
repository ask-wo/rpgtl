import type { Catalog, GlossaryTerm, TermEdit, Text } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import * as Struct from "effect/Struct";
import * as Schema from "effect/Schema";
import { entryTexts, withTexts } from "./catalog.ts";
import { wordPattern } from "./checks.ts";
import { keepsTags, withoutTags } from "./engines/xp/databaseTags.ts";
import { hasTerm } from "./termMatch.ts";
import { textsToClear } from "./shortNames.ts";
import { cleared, termKind, translationInUse, withTranslationMapped } from "./inUse.ts";

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
export const withoutStrayPronoun = (term: GlossaryTerm): GlossaryTerm => {
  if (termKind(term) === "character") return term;
  const {
    rulesPronoun: _,
    modelPronoun: __,
    userPronoun: ___,
    sheClues: ____,
    heClues: _____,
    ...rest
  } = term;
  return rest;
};

/** The user's own values of a term, as the Glossary page saves them. */
export const termEdit = ({
  source,
  userTranslation,
  userKind,
  userPronoun,
}: GlossaryTerm): TermEdit => ({
  source,
  ...(userTranslation !== undefined && { userTranslation }),
  ...(userKind !== undefined && { userKind }),
  ...(userPronoun !== undefined && { userPronoun }),
});

/**
 * The term the user saved, with the rules' and the model's values of `saved`, the term of its
 * source before. Empty English leaves the term without any, and English typed drops the one it
 * had before it was cleared. A term the user adds is a name, as the
 * rules say until a run's model sorts it; it has an id below 0 until it is saved.
 */
export function savedTerm(
  saved: GlossaryTerm | undefined,
  edit: TermEdit,
  newId: number,
): GlossaryTerm {
  const typed = edit.userTranslation?.trim();
  const before: GlossaryTerm = saved ?? { id: newId, source: edit.source, rulesKind: "name" };
  const { userTranslation: _, ...untyped } = before;
  const { userKind: __, userPronoun: ___, ...kept } = typed === "" ? cleared(before) : untyped;
  const values = typed ? Struct.omit(kept, ["previousTranslation"]) : kept;
  return withoutStrayPronoun({
    ...values,
    source: edit.source,
    ...(typed && { userTranslation: typed }),
    ...(edit.userKind !== undefined && { userKind: edit.userKind }),
    ...(edit.userPronoun !== undefined && { userPronoun: edit.userPronoun }),
  });
}

/** The terms whose English changed from `old` to `next` to other English, by source. */
const renames = (old: ReadonlyArray<GlossaryTerm>, next: ReadonlyArray<GlossaryTerm>) => {
  const after = new Map(next.map((term) => [term.source, translationInUse(term).trim()]));
  return new Map(
    old.flatMap((before) => {
      const to = after.get(before.source);
      const from = translationInUse(before).trim();
      return to && to !== from
        ? [[before.source, { from, to, previous: before.previousTranslation }] as const]
        : [];
    }),
  );
};

/**
 * The glossary `next` with each term that contains a renamed term's source, such as an item
 * named after a character, following the rename in English a run gave. A term typed again after
 * clearing renames from the English it had before.
 */
export function withRenamesFollowed(
  old: ReadonlyArray<GlossaryTerm>,
  next: ReadonlyArray<GlossaryTerm>,
) {
  const renamed = [...renames(old, next)];
  if (!renamed.length) return next;
  return next.map((term) => {
    if (term.userTranslation !== undefined) return term;
    return renamed.reduce((english, [source, { from, to, previous }]) => {
      const was = from || previous;
      return was && source !== term.source && hasTerm(term.source, source)
        ? withTranslationMapped(english, (value) => value.replace(wordPattern(was), () => to))
        : english;
    }, term);
  });
}

/**
 * The translation a text gets when the glossary changes from `old` to `next`: a text that is
 * exactly a term whose English changed to another one follows it.
 */
export function renamedTranslation(
  old: ReadonlyArray<GlossaryTerm>,
  next: ReadonlyArray<GlossaryTerm>,
) {
  const renamed = renames(old, next);
  return (text: Text): Text => {
    const term = renamed.get(text.source.trim());
    return term && translationInUse(text).trim() === term.from
      ? withTranslationMapped(text, () => term.to)
      : text;
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
  let added = Math.min(0, ...current.glossary.map((term) => term.id));
  const glossary = withRenamesFollowed(
    current.glossary,
    edited.map((edit) => savedTerm(saved.get(edit.source), edit, (added -= 1))),
  );
  return Result.succeed({
    ...current,
    texts: current.texts.map(renamedTranslation(current.glossary, glossary)),
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
        (term) => wanted.has(term.source) && (!mismatchesOnly || translationInUse(term).trim()),
      )
      .flatMap((term) => textsToClear(catalog, term, mismatchesOnly).map((text) => text.id)),
  );
  return {
    cleared: ids.size,
    catalog: withTexts(catalog, (text) => (ids.has(text.id) ? cleared(text) : text)),
  };
}

/**
 * The catalog with the English that runs gave these terms cleared, and that of the texts
 * that are a cleared term or contain it, so the next run translates them again. English the user
 * typed stays. A term without an entry of its own stays too: only an entry's answer fills a term
 * again.
 */
export function withTermTranslationsCleared(catalog: Catalog, sources: ReadonlyArray<string>) {
  const wanted = new Set(sources);
  const ownEntry = new Set(
    entryTexts(catalog).map((entry) =>
      (keepsTags(catalog.game.engine, entry) ? withoutTags(entry.source) : entry.source).trim(),
    ),
  );
  const clears = (term: GlossaryTerm) =>
    wanted.has(term.source) &&
    term.userTranslation === undefined &&
    translationInUse(term) !== "" &&
    ownEntry.has(term.source.trim());
  const terms = catalog.glossary.filter(clears);
  const ids = new Set(
    terms.flatMap((term) =>
      textsToClear(catalog, term, false)
        .filter((text) => text.userTranslation === undefined)
        .map((text) => text.id),
    ),
  );
  return {
    terms: terms.length,
    texts: ids.size,
    catalog: withTexts(
      {
        ...catalog,
        glossary: catalog.glossary.map((term): GlossaryTerm =>
          clears(term) ? cleared(term) : term,
        ),
      },
      (text) => (ids.has(text.id) ? cleared(text) : text),
    ),
  };
}
