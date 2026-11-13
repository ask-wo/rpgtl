import type { AnswerContext, RejectReason, RequestLine, RunKind } from "@rpgtl/contracts";
import {
  answerTokenLimit,
  type BatchRequest,
  batchRequest,
  batchVerdict,
  type CatalogDraft,
  checkAnswer,
  type RunEntry,
  isSuggestible,
  kindQuestion,
  nameGroups,
  packGroups,
  sceneBatches,
  type Prepared,
  pronounQuestion,
  readAnswers,
  requestGlossary,
  requestPronouns,
  shownLength,
  shownPronoun,
  shorterAnswersQuestion,
  speakerEntries,
  textGroups,
  tooLongForImage,
  TranslationAnswer,
  translationSystemPrompt,
  translationUserMessage,
  entryTranslation,
  termTranslation,
} from "@rpgtl/domain";
import * as AiError from "effect/ai/AiError";
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Schema from "effect/Schema";
import type * as StateFolder from "../state/StateFolder.ts";
import type { TextMessage } from "./prompt.ts";
import { RunReport } from "./RunReport.ts";

/** What a request asks: translations in the glossary pass or the text pass, or another question. */
type RequestKind = "names" | "text" | "question";

/** One of a run's two passes, names and the glossary first, then the rest of the text. */
export interface Pass {
  /** The model's name, for the run's log. */
  readonly model: string;
  /** Requests at once. */
  readonly parallel: number;
  /**
   * Gives `self` the pass's model; a model that starts with the pass may fail to, and reports
   * the start as the run's step.
   */
  readonly provide: <A, E, R>(
    self: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AiError.AiError, Exclude<R, LanguageModel.LanguageModel> | RunReport>;
  /**
   * Sets the model's settings for the requests in `self`; `answerTokens` caps a translation's
   * answer where the translator takes a cap, and `retry` marks a batch asked again after it failed
   * its checks.
   */
  readonly configure: (request: {
    readonly kind: RequestKind;
    readonly answerTokens?: number | undefined;
    readonly retry?: boolean;
  }) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Whether a request filled the model's context window, which cuts the prompt or the answer. */
  readonly contextFull: (response: LanguageModel.GenerateTextResponse<{}>) => boolean;
  /** A warning about the model once it answered, such as part of it running on the CPU. */
  readonly loadedWarning: Effect.Effect<Option.Option<string>>;
}

/** How a run asks one translator, set from the run's settings. */
export interface Translator {
  readonly names: Pass;
  readonly text: Pass;
  /** Entries per request. */
  readonly batchSize: number;
  /** Entries of one scene the text pass sends in one request instead of `batchSize` at a time. */
  readonly sceneSize: number;
  /** Earlier lines of the scene sent with each batch. */
  readonly contextLines: number;
  /**
   * Whether short event lists share a batch. Each Claude or Codex request starts a CLI process
   * and carries its own text, so they get big batches, packed with several scenes.
   */
  readonly packsScenes: boolean;
  /**
   * Whether the translator caches the system prompt, which it then reads back only while it stays
   * the same: every request sends all instructions, and the glossary pass's first request goes
   * alone, so the others read its instructions from the cache instead of each writing them.
   */
  readonly cachesPrompt: boolean;
  /** Whether answers are capped at `answerTokenLimit`; a reply that hits it repeated itself. */
  readonly capsAnswers: boolean;
  /**
   * Whether the model answers a retry the same way: an entry that repeats itself until the answer
   * runs out of room then does so again, so it isn't retried.
   */
  readonly deterministic: boolean;
}

type Gate = <A, E, R>(request: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

/** The longest a request may take before the run gives up on the translator. */
const requestTimeout = Duration.minutes(10);

const timedOut = () =>
  AiError.make({
    module: "translate",
    method: "generateObject",
    reason: new AiError.InternalProviderError({
      description: "The translator gave no answer within 10 minutes.",
    }),
  });

const loggedEntry = ({ entry }: Prepared) => ({
  id: entry.id,
  ...(entry.location && { location: entry.location }),
  source: entry.source,
  translation: entryTranslation(entry),
});

/** A reply to a translation request: its text and what the translator counted, when it did. */
interface Reply {
  readonly text: string;
  readonly response: LanguageModel.GenerateTextResponse<{}> | undefined;
  readonly ms: number;
}

/** What a reply's log line says about the request itself. */
const replyFields = (model: string, messages: ReadonlyArray<TextMessage>, reply: Reply) => {
  const usage = reply.response?.usage;
  const finish = reply.response?.content.find((part) => part.type === "finish");
  const ollama = finish?.metadata.ollama;
  const claude = finish?.metadata.claude;
  const promptTokens = usage?.inputTokens.total ?? usage?.inputTokens.uncached;
  const outputTokens = usage?.outputTokens.total;
  return {
    request: { model, messages: [...messages] },
    content: reply.text,
    ms: reply.ms,
    ...(promptTokens !== undefined && { promptTokens }),
    ...(outputTokens !== undefined && { outputTokens }),
    ...(ollama?.promptMs != null && { promptMs: ollama.promptMs }),
    ...(ollama?.outputMs != null && { outputMs: ollama.outputMs }),
    ...(claude && { costUsd: claude.costUsd }),
  } satisfies Partial<RequestLine>;
};

/** Asks for one JSON object; the reply's text when it isn't one that fits `schema`. */
const askObject = Effect.fn("translate.askObject")(function* (
  messages: ReadonlyArray<TextMessage>,
  schema: ReturnType<typeof TranslationAnswer>,
) {
  const started = yield* Clock.currentTimeMillis;
  const elapsed = Clock.currentTimeMillis.pipe(Effect.map((now) => now - started));
  return yield* LanguageModel.generateObject({ prompt: messages, schema }).pipe(
    Effect.timeoutOrElse({ duration: requestTimeout, orElse: () => Effect.fail(timedOut()) }),
    Effect.flatMap((response) =>
      Effect.map(elapsed, (ms): Reply => ({ text: response.text, response, ms })),
    ),
    Effect.catchReason("AiError", "StructuredOutputError", (reason) =>
      Effect.map(elapsed, (ms): Reply => ({ text: reason.responseText, response: undefined, ms })),
    ),
  );
});

/**
 * Translates the draft's untranslated entries: names into the glossary first, then the glossary
 * sorted by kind and the characters' pronouns, then, in a `translate` run, the rest of the text.
 * Batches that fail their checks are asked again in halves down to single entries; the draft
 * lists the ones that still fail. A request that fails ends the run.
 */
export const translateCatalog = Effect.fn("translateCatalog")(function* (
  draft: CatalogDraft,
  translator: Translator,
  runKind: RunKind,
) {
  const report = yield* RunReport;

  const systemPrompt = (entries: BatchRequest["entries"], names: boolean) =>
    translationSystemPrompt({
      language: draft.language,
      names,
      scenes: translator.cachesPrompt || entries.some((entry) => entry.scene !== undefined),
      following: translator.cachesPrompt,
    });

  /**
   * Runs requests as they come, or, with `warmFirst`, the first one alone and the others once it
   * has ended.
   */
  const makeGate = Effect.fn("translate.makeGate")(function* (warmFirst: boolean) {
    const firstDone = yield* Deferred.make<void>();
    const claimed = yield* Ref.make(!warmFirst);
    const gate: Gate = (request) =>
      Effect.flatMap(Ref.getAndSet(claimed, true), (taken) =>
        !warmFirst
          ? request
          : taken
            ? Effect.andThen(Deferred.await(firstDone), request)
            : Effect.ensuring(request, Deferred.succeed(firstDone, undefined)),
      );
    return gate;
  });

  /** Translates groups of entries, `translator.parallel` at a time, in one pass. */
  const translateGroups = Effect.fn("translate.groups")(function* (
    pass: Pass,
    groups: ReadonlyArray<ReadonlyArray<RunEntry>>,
    names: boolean,
  ) {
    const queue = translator.packsScenes ? packGroups(groups, translator.batchSize) : groups;
    if (!queue.length) return;
    const gated = yield* makeGate(names && translator.cachesPrompt);
    const warned = yield* Ref.make(false);
    const warnOnce = Effect.flatMap(Ref.getAndSet(warned, true), (done) =>
      done
        ? Effect.void
        : Effect.flatMap(
            pass.loadedWarning,
            Option.match({ onNone: () => Effect.void, onSome: report.warn }),
          ),
    );
    const contextWarned = yield* Ref.make(false);
    const warnContextFull = Effect.flatMap(Ref.getAndSet(contextWarned, true), (done) =>
      done
        ? Effect.void
        : report.warn(
            "A batch filled the model's context window, so it was split and retried. Entries that still fail are too long for it.",
          ),
    );

    /** Sends a translation request, logging it when it fails. */
    const send = Effect.fn("translate.send")(function* (
      batch: ReadonlyArray<Prepared>,
      messages: ReadonlyArray<TextMessage>,
      keys: ReadonlyArray<string>,
      answerTokens: number | undefined,
      retry = false,
    ) {
      return yield* gated(askObject(messages, TranslationAnswer(keys))).pipe(
        pass.configure({ kind: names ? "names" : "text", answerTokens, retry }),
        Effect.tapError((error) =>
          report.request({
            entryIds: batch.map(({ entry }) => entry.id),
            entries: batch.map(loggedEntry),
            answerContexts: batch.map((item) => draft.answerContext(item)),
            request: { model: pass.model, messages: [...messages] },
            error: error.reason.message,
            ms: 0,
            rejected: [],
          }),
        ),
      );
    });

    const translateGroup = Effect.fn("translate.group")(function* (group: ReadonlyArray<RunEntry>) {
      const prepared = group.map((entry) => draft.prepare(entry));
      for (const item of prepared) {
        if (entryTranslation(item.entry)) {
          // A name that is already translated still belongs in the glossary.
          if (names) draft.seedTerm(item.entry);
          continue;
        }
        const term = draft.term(item.entry.source);
        const exact = term && termTranslation(term);
        if (exact) draft.accept(item, exact, { seedGlossary: names });
        else if (!/[\p{L}\p{N}]/u.test(item.text.replace(/\{\d+\}/g, "")))
          draft.accept(item, item.entry.source, { seedGlossary: names });
      }

      /** Asks once more for answers too long for their images, keeping one only if it fits. */
      const shorten = Effect.fn("translate.shorten")(function* (
        long: ReadonlyArray<{
          readonly item: Prepared;
          readonly index: number;
          readonly answer: string;
          readonly translation: string;
          readonly flag: string | undefined;
          readonly limit: number;
        }>,
        first: {
          readonly messages: ReadonlyArray<TextMessage>;
          readonly reply: string;
          readonly contexts: ReadonlyArray<AnswerContext>;
          readonly entries: BatchRequest["entries"];
        },
      ) {
        const keys = long.map(({ index }) => String(index + 1));
        const messages: ReadonlyArray<TextMessage> = [
          ...first.messages,
          { role: "assistant", content: first.reply },
          {
            role: "user",
            content: shorterAnswersQuestion(
              long.map(({ index, answer, translation, limit }) => ({
                id: String(index + 1),
                answer,
                length: shownLength(translation),
                limit,
              })),
            ),
          },
        ];
        const followUp = first.entries.filter((entry) => keys.includes(entry.id));
        const reply = yield* send(
          long.map(({ item }) => item),
          messages,
          keys,
          translator.capsAnswers ? answerTokenLimit(followUp) : undefined,
        );
        const answers = readAnswers(keys, reply.text);
        for (const [position, { item, index, translation, flag, limit }] of long.entries()) {
          const second = checkAnswer(
            item.entry,
            answers?.[position],
            first.contexts[index],
            draft.keepsTags(item.entry),
          );
          if (second._tag === "Success" && shownLength(second.success.translation) <= limit)
            draft.accept(item, second.success.translation, {
              flag: ["shortened to fit its image", second.success.flag].filter(Boolean).join("; "),
              long: translation,
              seedGlossary: names,
            });
          else draft.accept(item, translation, { flag, seedGlossary: names });
        }
        yield* report.request({
          entryIds: long.map(({ item }) => item.entry.id),
          entries: long.map(({ item }) => loggedEntry(item)),
          answerContexts: long.flatMap(({ index }) => first.contexts[index] ?? []),
          ...replyFields(pass.model, messages, reply),
          rejected: [],
        });
      });

      const translateBatch = Effect.fn("translate.batch")(function* (
        all: ReadonlyArray<Prepared>,
        retry = false,
      ): Effect.fn.Return<
        void,
        AiError.AiError | StateFolder.StateFileError,
        LanguageModel.LanguageModel | RunReport
      > {
        // Copies of repeated text filled since the batch was made are not sent.
        const batch = all.filter((item) => !entryTranslation(item.entry));
        if (!batch.length) return;
        const request = batchRequest(draft, prepared, batch, translator.contextLines);
        const keys = request.entries.map((entry) => entry.id);
        const messages: ReadonlyArray<TextMessage> = [
          { role: "system", content: systemPrompt(request.entries, names) },
          {
            role: "user",
            content: translationUserMessage({
              glossary: requestGlossary(draft.glossary, request.entries),
              pronouns: requestPronouns(draft.glossary, request.entries),
              context: request.context,
              entries: request.entries,
              following: [],
            }),
          },
        ];
        const answerTokens = translator.capsAnswers ? answerTokenLimit(request.entries) : undefined;
        const reply = yield* send(batch, messages, keys, answerTokens, retry);
        yield* warnOnce;
        const answers = readAnswers(keys, reply.text);
        const verdict = batchVerdict({
          batch,
          text: reply.text,
          answers,
          outputTokens: reply.response?.usage.outputTokens.total,
          answerTokens,
          contextFull: reply.response !== undefined && pass.contextFull(reply.response),
        });
        if (verdict.contextFull) yield* warnContextFull;
        const contexts = batch.map((item) => draft.answerContext(item));
        const rejected: Array<{ readonly item: Prepared; readonly reason: RejectReason }> = [];
        const long: Array<Parameters<typeof shorten>[0][number]> = [];
        for (const [index, item] of batch.entries()) {
          // An earlier copy in this batch may have filled it already.
          if (entryTranslation(item.entry)) continue;
          const answer = answers?.[index];
          const reason =
            verdict.rejected ?? (verdict.repeating === index ? "answer too long" : undefined);
          const checked =
            reason === undefined
              ? checkAnswer(item.entry, answer, contexts[index], draft.keepsTags(item.entry))
              : undefined;
          if (checked === undefined || checked._tag === "Failure") {
            const why = checked?.failure ?? reason ?? "no answer";
            rejected.push({ item, reason: why });
            if (answer !== undefined && isSuggestible(why)) draft.suggest(item, answer, why);
            continue;
          }
          const limit = draft.limit(item.entry);
          if (
            answer !== undefined &&
            limit !== undefined &&
            checked.success.flag?.includes(tooLongForImage)
          )
            long.push({
              item,
              index,
              answer,
              translation: checked.success.translation,
              flag: checked.success.flag,
              limit,
            });
          else
            draft.accept(item, checked.success.translation, {
              flag: checked.success.flag,
              seedGlossary: names,
            });
        }
        yield* report.request({
          entryIds: batch.map(({ entry }) => entry.id),
          entries: batch.map(loggedEntry),
          answerContexts: contexts,
          ...replyFields(pass.model, messages, reply),
          rejected: rejected.map(({ item, reason }) => ({
            id: item.entry.id,
            source: item.entry.source,
            codes: [...item.codes],
            reason,
          })),
        });
        if (long.length)
          yield* shorten(long, { messages, reply: reply.text, contexts, entries: request.entries });
        const [only] = batch;
        if (only && batch.length === 1 && rejected.length) draft.fail(only.entry);
        const repeating =
          translator.deterministic && verdict.repeating !== undefined
            ? batch[verdict.repeating]
            : undefined;
        if (repeating) draft.fail(repeating.entry);
        yield* report.progress;
        if (batch.length === 1) return;
        const again = rejected.map(({ item }) => item).filter((item) => item !== repeating);
        if (!again.length) return;
        const half = Math.ceil(again.length / 2);
        yield* translateBatch(again.slice(0, half), true);
        if (half < again.length) yield* translateBatch(again.slice(half), true);
      });

      // Batches within a group go in order, since later ones use earlier translations as context.
      const missing = prepared.filter((item) => !entryTranslation(item.entry));
      const sceneSize = names ? translator.batchSize : translator.sceneSize;
      for (const batch of sceneBatches(missing, translator.batchSize, sceneSize))
        yield* translateBatch(batch);
    });

    yield* Effect.forEach(queue, translateGroup, {
      concurrency: pass.parallel,
      discard: true,
    });
  });

  /** Asks one JSON question outside translation and logs it; none when it gets no answer. */
  const ask = Effect.fn("translate.ask")(function* <S extends Schema.Struct<Schema.Struct.Fields>>(
    pass: Pass,
    question: { readonly system: string; readonly user: string; readonly answer: S },
  ) {
    const started = yield* Clock.currentTimeMillis;
    const answer = yield* LanguageModel.generateObject({
      prompt: [
        { role: "system", content: question.system },
        { role: "user", content: question.user },
      ],
      schema: question.answer,
    }).pipe(
      Effect.timeoutOrElse({ duration: requestTimeout, orElse: () => Effect.fail(timedOut()) }),
      Effect.map((response) => response.value),
      pass.configure({ kind: "question" }),
      Effect.result,
    );
    const ms = (yield* Clock.currentTimeMillis) - started;
    yield* report.ask({
      model: pass.model,
      system: question.system,
      user: question.user,
      ...(answer._tag === "Success"
        ? { answer: answer.success }
        : { error: answer.failure.reason.message }),
      ms,
    });
    // The glossary keeps what the rules gave a term the model couldn't answer about.
    return answer._tag === "Success" ? answer.success : undefined;
  });

  /** Sorts the terms the model hasn't sorted by kind, `batchSize` at a time. */
  const sortTerms = Effect.fn("translate.sortTerms")(function* (pass: Pass) {
    const terms = draft.termsToSort();
    const batches = Array.from({ length: Math.ceil(terms.length / translator.batchSize) }, (_, i) =>
      terms.slice(i * translator.batchSize, (i + 1) * translator.batchSize),
    );
    const sorted = yield* Ref.make(0);
    const step = (count: number) =>
      report.step(
        `Sorting glossary terms into characters, names and words: ${count} of ${terms.length}`,
      );
    if (terms.length) yield* step(0);
    yield* Effect.forEach(
      batches,
      Effect.fnUntraced(function* (batch) {
        const kinds = yield* ask(
          pass,
          kindQuestion(
            batch.map(({ input }) => input),
            draft.language,
          ),
        );
        for (const [index, { term }] of batch.entries()) {
          const kind = kinds?.[String(index + 1)];
          if (kind) draft.setKind(term, kind);
        }
        yield* step(yield* Ref.updateAndGet(sorted, (count) => count + batch.length));
      }),
      { concurrency: pass.parallel, discard: true },
    );
  });

  /** Gives characters their pronouns from the text, and asks the model where it says nothing. */
  const findPronouns = Effect.fn("translate.findPronouns")(function* (pass: Pass) {
    const unknown = draft.pronounsFromClues();
    const checked = yield* Ref.make(0);
    const step = (count: number) =>
      report.step(`Finding the pronouns of characters: ${count} of ${unknown.length}`);
    if (unknown.length) yield* step(0);
    yield* Effect.forEach(
      unknown,
      Effect.fnUntraced(function* ({ term, lines }) {
        const answer = yield* ask(pass, pronounQuestion(term, lines, draft.language));
        if (answer) draft.setPronoun(term, shownPronoun(term, lines, answer, draft.language));
        yield* step(yield* Ref.updateAndGet(checked, (count) => count + 1));
      }),
      { concurrency: pass.parallel, discard: true },
    );
  });

  const namesPass = Effect.gen(function* () {
    const pass = translator.names;
    yield* report.step(undefined);
    yield* translateGroups(pass, nameGroups(draft.translatable, translator.batchSize), true);
    const speakers = speakerEntries(
      draft,
      draft.entries.map((entry) => draft.prepare(entry)),
    );
    yield* translateGroups(pass, speakers.length ? [speakers] : [], true);
    yield* sortTerms(pass);
    yield* findPronouns(pass);
    yield* report.step(undefined);
    yield* report.progress;
  });

  yield* translator.names.provide(namesPass);

  if (runKind === "translate") {
    yield* report.textPass;
    yield* translator.text.provide(
      translateGroups(translator.text, textGroups(draft.translatable), false),
    );
  }
});
