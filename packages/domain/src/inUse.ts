import type { GlossaryTerm, TermKind, Text } from "@rpgtl/contracts";

type Layered<A> = {
  readonly rules?: A | undefined;
  readonly model?: A | undefined;
  readonly user?: A | undefined;
};
const inUse = <A>({ rules, model, user }: Layered<A>) => user ?? model ?? rules;

type Translated = Partial<Pick<Text, "modelTranslation" | "userTranslation">>;

/** A text's or term's translation in use: the user's, else the model's; empty while it has none. */
export const translationInUse = (text: Translated) =>
  text.userTranslation ?? text.modelTranslation ?? "";

/** Whether the translation in use is the user's own. */
export const isUserTranslation = (text: Pick<Text, "userTranslation">) =>
  text.userTranslation !== undefined;

/** A glossary term's kind in use. */
export const termKind = (
  term: Pick<GlossaryTerm, "rulesKind" | "modelKind" | "userKind">,
): TermKind => term.userKind ?? term.modelKind ?? term.rulesKind;

/** A character's pronoun in use, if RPGTL or the user has given one. */
export const termPronoun = (
  term: Pick<GlossaryTerm, "rulesPronoun" | "modelPronoun" | "userPronoun">,
) => inUse({ rules: term.rulesPronoun, model: term.modelPronoun, user: term.userPronoun });

type Written = Translated &
  Partial<
    Pick<Text, "modelOperationId" | "unshortenedTranslation" | "flagReason" | "previousTranslation">
  >;

/**
 * The text without a translation, so the next run translates it, keeping the one it had as its
 * previous translation. A rejected answer stays.
 */
export const cleared = <T extends Written>(text: T) => {
  const {
    modelTranslation: _,
    modelOperationId: __,
    unshortenedTranslation: ___,
    flagReason: ____,
    userTranslation: _____,
    previousTranslation,
    ...rest
  } = text;
  const was = translationInUse(text) || previousTranslation;
  return { ...rest, ...(was !== undefined && { previousTranslation: was }) };
};

/** The text without the model's translation and what the model said about it. */
export const withoutModelTranslation = <T extends Written>(text: T) => {
  const {
    modelTranslation: _,
    modelOperationId: __,
    unshortenedTranslation: ___,
    flagReason: ____,
    ...rest
  } = text;
  return rest;
};

/**
 * The text with the translation the user typed: empty clears it. One equal to the translation
 * otherwise in use isn't kept, so that one is in use again.
 */
export function withUserTranslation<T extends Written>(text: T, typed: string) {
  if (!typed) return cleared(text);
  const { userTranslation: _, previousTranslation: __, ...rest } = text;
  return { ...rest, ...(typed !== text.modelTranslation && { userTranslation: typed }) };
}

/**
 * The text with a run's model's translation and what the run says about it, in place of the last
 * one's; a user translation equal to it isn't kept, and the rejected answer goes.
 */
export function withModelTranslation<
  T extends Written & Partial<Pick<Text, "rejectedTranslation" | "rejectionReason">>,
>(text: T, answer: Pick<Text, "modelTranslation" | "unshortenedTranslation" | "flagReason">) {
  const {
    modelTranslation: _,
    modelOperationId: __,
    unshortenedTranslation: ___,
    flagReason: ____,
    rejectedTranslation: _____,
    rejectionReason: ______,
    previousTranslation: _______,
    userTranslation,
    ...rest
  } = text;
  return {
    ...rest,
    ...answer,
    ...(userTranslation !== undefined &&
      userTranslation !== answer.modelTranslation && { userTranslation }),
  };
}

/** The text with its translation in use mapped by `f` as the user's, as when it follows a rename. */
export function withTranslationMapped<T extends Written>(text: T, f: (value: string) => string) {
  const value = translationInUse(text);
  if (!value) return text;
  const mapped = f(value);
  return mapped === value ? text : withUserTranslation(text, mapped);
}
