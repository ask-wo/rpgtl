import type { Catalog, Entry, GlossaryTerm, Pronoun, RunModels } from "@rpgtl/contracts";
import * as Struct from "effect/Struct";
import { splitVersion } from "./gameIdentity.ts";
import { entryTranslation, isUserValue, withUser } from "./guesses.ts";

/** The English of the game's title in System.json without its version, if it has any. */
export const titleTranslation = ({ entries }: Pick<Catalog, "entries">) => {
  const entry = entries.find(
    (each) => each.file === "System.json" && each.path.length === 1 && each.path[0] === "gameTitle",
  );
  return entry ? splitVersion(entryTranslation(entry)).name.trim() || undefined : undefined;
};

/**
 * Whether `entries`, the text of a game folder, belong to the game the catalog was built from: at
 * least half of the catalog's text entries are among them, so a moved copy or an update of the
 * game passes and another game doesn't. Image entries don't count, as the folder isn't read for
 * them.
 */
export function sameGame(
  catalog: Pick<Catalog, "entries">,
  entries: ReadonlyArray<Pick<Entry, "id">>,
) {
  const found = new Set(entries.map((entry) => entry.id));
  const text = catalog.entries.filter((entry) => !entry.file.startsWith("img/"));
  return text.filter((entry) => found.has(entry.id)).length * 2 >= text.length;
}

/** An entry-like `T` whose English the user or a rule just changed. */
type ChangedTranslation<T> = Omit<T, "translation" | "previous"> &
  Pick<Entry, "translation" | "previous">;

/** The entry with its English cleared, so the next run translates it; `previous` keeps it. */
export function cleared<T extends Pick<Entry, "translation" | "previous">>(
  entry: T,
): ChangedTranslation<T> {
  const was = entryTranslation(entry);
  const { previous, translation: _, ...rest } = entry;
  return { ...rest, translation: {}, ...((was || previous) && { previous: was || previous }) };
}

/**
 * The entry with the English the user typed: empty clears it, and the run's guess is kept beside
 * other English, to go back to.
 */
export function withTranslation<T extends Pick<Entry, "translation" | "previous">>(
  entry: T,
  typed: string,
): ChangedTranslation<T> {
  if (!typed) return cleared(entry);
  const { previous, translation, ...rest } = entry;
  return {
    ...rest,
    translation: withUser(translation, typed),
    ...(previous !== undefined && previous !== typed && { previous }),
  };
}

/** The runs of `runs` that one of `items` names, so a run none of them names any more is dropped. */
export const namedRuns = <R>(
  items: Iterable<{ readonly run?: string }>,
  runs: Readonly<Record<string, R>> = {},
): { readonly runs?: Record<string, R> } => {
  const named = new Set([...items].flatMap((item) => (item.run ? [item.run] : [])));
  const kept = Object.entries(runs).filter(([started]) => named.has(started));
  return kept.length ? { runs: Object.fromEntries(kept) } : {};
};

/**
 * The catalog with every translation cleared, and with what runs left on its entries. The switch
 * stays as it was.
 */
export const restoredCatalog = (catalog: Catalog): Catalog => ({
  ...catalog,
  entries: catalog.entries.map((entry) => cleared(Struct.omit(entry, ["suggestion"]))),
});

/** A guessed value in the catalog, with what it is the value of. */
export type GuessedOf =
  | { readonly of: "translation"; readonly entry: Entry; readonly value: Entry["translation"] }
  | {
      readonly of: "termTranslation";
      readonly term: GlossaryTerm;
      readonly value: GlossaryTerm["translation"];
    }
  | { readonly of: "kind"; readonly term: GlossaryTerm; readonly value: GlossaryTerm["kind"] }
  | { readonly of: "pronoun"; readonly term: GlossaryTerm; readonly value: Pronoun };

/** Every guessed value of the catalog's entries and glossary. */
export function* guessedValues({
  entries,
  glossary,
}: Pick<Catalog, "entries" | "glossary">): Generator<GuessedOf> {
  for (const entry of entries) yield { of: "translation", entry, value: entry.translation };
  for (const term of glossary) {
    yield { of: "termTranslation", term, value: term.translation };
    yield { of: "kind", term, value: term.kind };
    if (term.pronoun) yield { of: "pronoun", term, value: term.pronoun };
  }
}

/** The catalog's runs that one of its guesses names, so a run none names any more is dropped. */
export const guessRuns = <R>(
  catalog: Pick<Catalog, "entries" | "glossary">,
  runs: Readonly<Record<string, R>> | undefined,
) =>
  namedRuns(
    [...guessedValues(catalog)].map(({ value }) => value.guess ?? {}),
    runs,
  );

/**
 * The catalog with the run that started at `started`, using `models`, among its runs, and as its
 * last run once the run translated an entry.
 */
export function withRunMarks(
  catalog: Catalog,
  { started, models }: { readonly started: string; readonly models: RunModels },
): Catalog {
  const { runs, ...rest } = catalog;
  return {
    ...rest,
    ...(catalog.entries.some((entry) => entry.translation.guess?.run === started) && {
      lastRun: started,
    }),
    ...guessRuns(catalog, { ...runs, [started]: models }),
  };
}

/**
 * Whether the guess is the run's that started at `started` and still in use, leaving out English
 * that is the entry's own text, as a line without words keeps.
 */
const inUseFrom = (started: string) => (guessed: GuessedOf) =>
  guessed.value.guess?.run === started &&
  !isUserValue(guessed.value) &&
  !(guessed.of === "translation" && guessed.value.guess.value === guessed.entry.source);

/** The catalog's runs, each with how many of its guesses are still in use. */
export const runsWithCounts = (catalog: Catalog) => {
  const all = [...guessedValues(catalog)];
  return Object.fromEntries(
    Object.entries(catalog.runs ?? {}).map(([started, models]) => [
      started,
      { ...models, guesses: all.filter(inUseFrom(started)).length },
    ]),
  );
};
