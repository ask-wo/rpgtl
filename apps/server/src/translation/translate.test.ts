import { assert, it } from "@effect/vitest";
import type { RequestLine } from "@rpgtl/contracts";
import { CatalogDraft, translationInUse } from "@rpgtl/domain";
import { testCatalog, type TestEntry } from "@rpgtl/domain/testUtils/catalog";
import * as AiError from "effect/ai/AiError";
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { textMessages } from "./prompt.ts";
import { RunReport } from "./RunReport.ts";
import { translateCatalog, type Pass } from "./translate.ts";

const line = (id: string, index: number, source: string): TestEntry => ({
  id,
  location: {
    _tag: "Message",
    list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
    index,
  },
  source,
});

const Request = Schema.fromJsonString(
  Schema.Struct({
    entries: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  }),
);

const english: Record<string, string> = {
  你好: "Hello",
  再见: "Goodbye",
  阿琳: "Arlene",
  阿琳的伞: "Arlene's Umbrella",
  阿琳的鞋: "Arlene's Shoes",
  不译: "<refused>",
};

/** Answers each line in `english`, and is flagged by safeguards when asked to translate 禁止. */
const model = LanguageModel.make({
  generateText: Effect.fnUntraced(function* (provider) {
    const user = (yield* textMessages("test", provider.prompt)).at(-1)?.content ?? "";
    // A question such as a term's kind gets no answer.
    const { entries } = yield* Schema.decodeEffect(Request)(user).pipe(
      Effect.catchTags({ SchemaError: () => Effect.succeed({ entries: [] }) }),
    );
    if (entries.some(({ text }) => text.includes("禁止")))
      return yield* AiError.make({
        module: "test",
        method: "generateText",
        reason: new AiError.ContentPolicyError({ description: "Flagged." }),
      });
    const answer = Object.fromEntries(entries.map(({ id, text }) => [id, english[text] ?? ""]));
    return [
      { type: "text", text: JSON.stringify(answer) },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: {}, outputTokens: {} },
      },
    ];
  }),
  streamText: () => {
    throw new Error("unused");
  },
});

const pass: Pass = {
  model: "fake",
  parallel: 1,
  provide: (self) => Effect.provideServiceEffect(self, LanguageModel.LanguageModel, model),
  configure: () => (self) => self,
  contextFull: () => false,
  loadedWarning: Effect.succeedNone,
};

/** Translates `entries`, `batchSize` per request, with the fake model; the draft and the run's request lines. */
const translated = (entries: ReadonlyArray<TestEntry>, batchSize = 40) => {
  const draft = new CatalogDraft(testCatalog({ entries }), new Map());
  const requests: Array<Omit<RequestLine, "type" | "at">> = [];
  const run = translateCatalog(
    draft,
    {
      names: pass,
      text: pass,
      batchSize,
      contextLines: 10,
      packsScenes: true,
      cachesPrompt: false,
      capsAnswers: false,
      deterministic: true,
      marksRefusals: true,
    },
    "translate",
  ).pipe(
    Effect.provideService(RunReport, {
      step: () => Effect.void,
      textPass: Effect.void,
      warn: () => Effect.void,
      request: (request) => Effect.sync(() => requests.push(request)),
      ask: () => Effect.void,
      speakers: () => Effect.void,
      progress: Effect.void,
    }),
  );
  return { draft, requests, run };
};

const item = (record: number, source: string): TestEntry => ({
  ...line(String(record), 0, source),
  location: { _tag: "RecordField", table: "items", record, field: "name" },
});

it.effect(
  "a name that other names contain is translated first, and their requests use its English",
  () =>
    Effect.gen(function* () {
      const { requests, run } = translated(
        [item(1, "阿琳的伞"), item(2, "阿琳的鞋"), item(3, "阿琳")],
        1,
      );
      yield* run;
      assert.deepStrictEqual(
        requests.map((request) => request.entryIds),
        [["3"], ["1"], ["2"]],
      );
      for (const request of requests.slice(1))
        assert.include(JSON.stringify(request.request.messages).toLowerCase(), "arlene");
    }),
);

it.effect("a batch the safeguards flag fails whole and is never asked again", () =>
  Effect.gen(function* () {
    const { draft, requests, run } = translated([line("a", 0, "你好"), line("b", 1, "禁止的话")]);
    yield* run;
    assert.deepStrictEqual(draft.failed, ["a", "b"]);
    assert.deepStrictEqual(
      requests.map((request) => [request.entryIds, request.error]),
      [[["a", "b"], "Content policy violation: Flagged."]],
    );
    assert.deepStrictEqual(
      requests[0]?.rejected.map(({ id, reason }) => [id, reason]),
      [
        ["a", "refused"],
        ["b", "refused"],
      ],
    );
  }),
);

it.effect(
  "an entry the model declines is asked again alone, and the rest of its batch is kept",
  () =>
    Effect.gen(function* () {
      const { draft, requests, run } = translated([line("a", 0, "你好"), line("b", 1, "不译")]);
      yield* run;
      assert.deepStrictEqual(draft.failed, ["b"]);
      assert.deepStrictEqual(draft.entries.map(translationInUse), ["Hello", ""]);
      assert.deepStrictEqual(
        requests.map((request) => [
          request.entryIds,
          request.rejected.map(({ id, reason }) => [id, reason]),
        ]),
        [
          [["a", "b"], [["b", "refused"]]],
          [["b"], [["b", "refused"]]],
        ],
      );
    }),
);

it.effect("the run stops once the safeguards have flagged three requests", () =>
  Effect.gen(function* () {
    const { draft, requests, run } = translated(
      ["禁止一", "你好", "禁止二", "禁止三", "禁止四"].map((source, index) =>
        line(String(index), index, source),
      ),
      1,
    );
    const error = yield* Effect.flip(run);
    assert.isTrue(AiError.isAiError(error) && error.reason._tag === "ContentPolicyError");
    assert.deepStrictEqual(draft.failed, ["0", "2", "3"]);
    assert.deepStrictEqual(draft.entries.map(translationInUse), ["", "Hello", "", "", ""]);
    assert.lengthOf(requests, 4);
  }),
);
