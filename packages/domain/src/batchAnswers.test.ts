import { assert, it } from "@effect/vitest";
import { batchVerdict, readAnswers } from "./index.ts";

const keys = ["1", "2"];
const batch = [{ text: "你好" }, { text: "再见" }];
const verdict = (text: string, counts: { outputTokens?: number; answerTokens?: number } = {}) =>
  batchVerdict({
    batch,
    text,
    answers: readAnswers(keys, text),
    outputTokens: counts.outputTokens,
    answerTokens: counts.answerTokens,
    contextFull: false,
  });

it("an extra blank key keeps a batch's answers, and an extra key with text drops them all", () => {
  assert.deepStrictEqual(readAnswers(keys, '{"1":"Hello","2":"Bye","3":" "}'), ["Hello", "Bye"]);
  assert.isUndefined(readAnswers(keys, '{"1":"Hello","2":"Bye","3":"Bye now"}'));
  assert.isUndefined(readAnswers(keys, '{"1":"Hello"}'));
  assert.deepStrictEqual(readAnswers(keys, '{"1":"Hello","2":7}'), ["Hello", undefined]);
});

it("answers that moved up one entry reject the whole batch", () => {
  assert.deepStrictEqual(verdict('{"1":"Bye","2":""}'), {
    rejected: "answers out of order",
    contextFull: false,
  });
  assert.deepStrictEqual(verdict('{"1":"Hello","2":"Bye"}'), { contextFull: false });
});

it("a reply that used up its tokens inside an answer points at the entry that repeated itself", () => {
  const cut = '{"1":"Hello","2":"Bye bye bye bye';
  assert.deepStrictEqual(verdict(cut, { answerTokens: 50 }), { repeating: 1, contextFull: false });
  assert.deepStrictEqual(
    verdict('{"1":"Hello","2":"Bye"}', { outputTokens: 50, answerTokens: 50 }),
    {
      repeating: 1,
      contextFull: false,
    },
  );
  // Without a cap on the answer, a cut-off reply is only unreadable.
  assert.deepStrictEqual(verdict(cut), { contextFull: false });
});

/** A batch whose request filled the context, with `outputTokens` of an answer capped at 50. */
const full = (outputTokens: number) =>
  batchVerdict({
    batch,
    text: '{"1":"Hello"}',
    answers: undefined,
    outputTokens,
    answerTokens: 50,
    contextFull: true,
  });

it("a refusal in prose rejects the batch, and a full context says so unless the answer ran out", () => {
  assert.deepStrictEqual(verdict("I'm sorry, but I can't translate this."), {
    rejected: "refused",
    contextFull: false,
  });
  assert.deepStrictEqual(full(10), { rejected: "context full", contextFull: true });
  assert.deepStrictEqual(full(50), { repeating: 0, contextFull: false });
});
