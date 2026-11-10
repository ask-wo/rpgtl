import type { RejectReason } from "@rpgtl/contracts";
import { outOfOrder } from "./answers.ts";
import { refusalPattern } from "./checks.ts";

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The answer for each key of a batch's reply, in key order, or none when the reply isn't one JSON
 * object with every key. An extra key with text makes the reply unusable too: the model may have
 * split a line and moved the later answers down. An answer that isn't text is missing.
 */
export function readAnswers(
  keys: ReadonlyArray<string>,
  text: string,
): ReadonlyArray<string | undefined> | undefined {
  const value = parsed(text);
  if (
    !isObject(value) ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    !Object.entries(value).every(
      ([key, answer]) => keys.includes(key) || (typeof answer === "string" && !answer.trim()),
    )
  )
    return undefined;
  return keys.map((key) => {
    const answer = value[key];
    return typeof answer === "string" ? answer : undefined;
  });
}

/** What a batch's reply says about all its entries before each answer is checked. */
export interface BatchVerdict {
  /** Why every entry is rejected, when one reason covers them all. */
  readonly rejected?: RejectReason;
  /** The entry the reply stopped in, which repeated itself until the reply ran out of room. */
  readonly repeating?: number;
  /** Whether the request filled the model's context, so the batch is too long for it. */
  readonly contextFull: boolean;
}

/**
 * Judges a batch's reply as a whole. `outputTokens` and `answerTokens` are how many tokens the
 * reply used and had room for, when the translator counts them; a reply cut off inside its JSON ran
 * out of room even when they are unknown. `contextFull` says the translator filled its context.
 */
export function batchVerdict({
  batch,
  text,
  answers,
  outputTokens,
  answerTokens,
  contextFull,
}: {
  readonly batch: ReadonlyArray<{ readonly text: string }>;
  readonly text: string;
  readonly answers: ReadonlyArray<string | undefined> | undefined;
  readonly outputTokens: number | undefined;
  readonly answerTokens: number | undefined;
  readonly contextFull: boolean;
}): BatchVerdict {
  const trimmed = text.trimStart();
  const cutOff = answers === undefined && trimmed.startsWith("{") && parsed(text) === undefined;
  const tooLong =
    answerTokens !== undefined &&
    ((outputTokens !== undefined && outputTokens >= answerTokens) || cutOff);
  // The reply stopped inside the value of its last key, so that entry is the one repeating.
  const lastKey = [...text.matchAll(/"(\d+)"\s*:/g)].at(-1)?.[1];
  const repeating = tooLong && lastKey !== undefined ? Number(lastKey) - 1 : undefined;
  const full = !tooLong && contextFull;
  const rejected: RejectReason | undefined = full
    ? "context full"
    : answers === undefined && !trimmed.startsWith("{") && refusalPattern.test(text)
      ? "refused"
      : answers !== undefined && outOfOrder(batch, answers)
        ? "answers out of order"
        : undefined;
  return {
    ...(rejected && { rejected }),
    ...(repeating !== undefined && repeating >= 0 && repeating < batch.length && { repeating }),
    contextFull: full,
  };
}
