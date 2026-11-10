import type { Entry, GlossaryTerm, TermKind } from "@rpgtl/contracts";

/** What a run or RPGTL's rules gave; no `run` means the rules did. */
export interface Guess<A> {
  readonly value: A;
  readonly run?: string;
}

/** A value a run or the rules guessed and the user may replace, as `Guessed` in the contracts. */
export interface GuessedValue<A, G extends Guess<A> = Guess<A>> {
  readonly guess?: G;
  readonly user?: A;
}

/** The value in use: the user's, or else the guess. */
export const inUse = <A>(guessed: GuessedValue<A>): A | undefined =>
  guessed.user ?? guessed.guess?.value;

/** Whether the value in use is the user's own. */
export const isUserValue = <A>(guessed: GuessedValue<A>) => guessed.user !== undefined;

/** The guessed value with the user's `value`, which isn't kept when it is the guess. */
export function withUser<A, G extends Guess<A>>(
  guessed: GuessedValue<A, G>,
  value: A,
): GuessedValue<A, G> {
  return {
    ...(guessed.guess !== undefined && { guess: guessed.guess }),
    ...(value !== guessed.guess?.value && { user: value }),
  };
}

/** The guessed value with a new guess; a user value equal to it isn't kept. */
export function withGuess<A, G extends Guess<A>>(
  guessed: GuessedValue<A, G>,
  guess: G,
): GuessedValue<A, G> {
  return {
    guess,
    ...(guessed.user !== undefined && guessed.user !== guess.value && { user: guessed.user }),
  };
}

/** The guessed value back at its guess. */
export const restored = <A, G extends Guess<A>>({
  guess,
}: GuessedValue<A, G>): GuessedValue<A, G> => (guess ? { guess } : {});

/** The guessed value without a guess, as when what the guess was made from changed. */
export const withoutGuess = <A, G extends Guess<A>>({
  user,
}: GuessedValue<A, G>): GuessedValue<A, G> => (user === undefined ? {} : { user });

/**
 * The guessed value in use mapped by `f`: a changed user value stays the user's, and a changed
 * guess becomes one of the rules, as no run gave it.
 */
export function mapInUse<A, G extends Guess<A>>(
  guessed: GuessedValue<A, G>,
  f: (value: A) => A,
): GuessedValue<A, G | Guess<A>> {
  if (guessed.user !== undefined) return withUser(guessed, f(guessed.user));
  if (!guessed.guess) return guessed;
  const value = f(guessed.guess.value);
  return value === guessed.guess.value ? guessed : { guess: { value } };
}

/** An entry's English in use, empty while it isn't translated. */
export const entryTranslation = (entry: Pick<Entry, "translation">) =>
  inUse(entry.translation) ?? "";

/** A glossary term's English in use, empty while it has none. */
export const termTranslation = (term: Pick<GlossaryTerm, "translation">) =>
  inUse(term.translation) ?? "";

/** A glossary term's kind in use. */
export const termKind = ({ kind }: Pick<GlossaryTerm, "kind">): TermKind =>
  kind.user ?? kind.guess.value;

/** A character's pronoun in use, if RPGTL or the user has given one. */
export const termPronoun = ({ pronoun }: Pick<GlossaryTerm, "pronoun">) =>
  pronoun && inUse(pronoun);

/**
 * The guessed value a translation file gives, against `saved`, the catalog's. The file's guess is
 * taken when `known` knows its run, or no run gave it, unless it is the saved guess's run with other
 * English, as when the exported file was edited by hand. The file's user value stays the user's,
 * as does a value in use other than the guess taken; none clears it.
 */
export function importedValue<A, G extends Guess<A>>(
  saved: GuessedValue<A, G>,
  file: GuessedValue<A, G>,
  known: (run: string) => boolean,
): GuessedValue<A, G> {
  const value = inUse(file);
  if (value === undefined) return {};
  const fileGuess = file.guess;
  const editedByHand =
    fileGuess?.run !== undefined &&
    fileGuess.run === saved.guess?.run &&
    fileGuess.value !== saved.guess.value;
  const guess =
    fileGuess && (fileGuess.run === undefined || known(fileGuess.run)) && !editedByHand
      ? fileGuess
      : saved.guess;
  const user = file.user ?? (value === guess?.value ? undefined : value);
  return { ...(guess && { guess }), ...(user !== undefined && { user }) };
}
