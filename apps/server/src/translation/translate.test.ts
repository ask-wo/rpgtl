import { assert, it } from "@effect/vitest";
import type { Catalog, Entry, RequestLine } from "@rpgtl/contracts";
import { CatalogDraft, entryTranslation } from "@rpgtl/domain";
import * as AiError from "effect/ai/AiError";
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { textMessages } from "./prompt.ts";
import { RunReport } from "./RunReport.ts";
import { translateCatalog, type Pass } from "./translate.ts";

const line = (id: string, index: number, source: string): Entry => ({
  id,
  location: {
    _tag: "Message",
    list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
    index,
  },
  source,
  translation: {},
});

const Request = Schema.fromJsonString(
  Schema.Struct({
    entries: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  }),
);

const english: Record<string, string> = { 你好: "Hello", 再见: "Goodbye" };

/** Answers each line in `english`, and is flagged by safeguards when asked to translate 禁止. */
const model = LanguageModel.make({
  generateText: Effect.fnUntraced(function* (provider) {
    const user = (yield* textMessages("test", provider.prompt)).at(-1)?.content ?? "";
    const { entries } = yield* Schema.decodeEffect(Request)(user).pipe(Effect.orDie);
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
const translated = (entries: Catalog["entries"], batchSize = 40) => {
  const catalog: Catalog = {
    version: 1,
    game: { id: "0123456789abcdef0123", title: "雨", engine: "MV" },
    translate: true,
    entries,
    glossary: [],
  };
  const draft = new CatalogDraft(catalog, new Map(), "2026-11-13T00:00:00.000Z");
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
    },
    "translate",
  ).pipe(
    Effect.provideService(RunReport, {
      step: () => Effect.void,
      textPass: Effect.void,
      warn: () => Effect.void,
      request: (request) => Effect.sync(() => requests.push(request)),
      ask: () => Effect.void,
      progress: Effect.void,
    }),
  );
  return { draft, requests, run };
};

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
    assert.deepStrictEqual(draft.catalog.entries.map(entryTranslation), ["", "Hello", "", "", ""]);
    assert.lengthOf(requests, 4);
  }),
);
