import {
  type Catalog,
  fileTime,
  gameFiles,
  type RunKind,
  type RunStatus,
  translationSettings,
  type RunModels,
  type TranslationSettings,
} from "@rpgtl/contracts";
import {
  CatalogDraft,
  isNameEntry,
  retrySampling,
  withRunMarks,
  entryTranslation,
} from "@rpgtl/domain";
import * as AiError from "effect/ai/AiError";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Catalogs from "../games/Catalogs.ts";
import * as Games from "../games/Games.ts";
import * as RunKinds from "../runs/RunKinds.ts";
import * as Settings from "../settings/Settings.ts";
import { endedPhase } from "../runs/endedPhase.ts";
import * as StateFolder from "../state/StateFolder.ts";
import { RunReport } from "./RunReport.ts";
import * as RunLogs from "./RunLogs.ts";
import { translateCatalog } from "./translate.ts";
import {
  EndpointRejectedError,
  numCtx,
  translatorFor,
  type TranslatorServices,
} from "./translators.ts";

/** A translator that couldn't be readied for the run, such as Codex without a login. */
class TranslatorUnavailableError extends Schema.TaggedError<TranslatorUnavailableError>()(
  "TranslatorUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "The translator couldn't be readied for the run.";
  }
}

/** What the page shows when a run ends early, from what ended it. */
export const runFailure = (cause: Cause.Cause<unknown>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => unexpected,
    onSome: failureMessage,
  });

/** A failure the page's message fully explains, such as a used-up subscription. */
const isExpected = (failure: unknown) =>
  AiError.isAiError(failure) &&
  (failure.reason._tag === "QuotaExhaustedError" ||
    failure.reason._tag === "RateLimitError" ||
    failure.reason._tag === "NetworkError" ||
    failure.reason._tag === "AuthenticationError");

const unexpected = "The run stopped on an unexpected error. RPGTL's log says more.";

/** What the page shows for an error a translator or the state folder failed with. */
const failureMessage = (failure: unknown): string => {
  if (AiError.isAiError(failure)) {
    const reason = failure.reason;
    switch (reason._tag) {
      case "NetworkError":
        return "Could not reach the translator. Is it running?";
      case "QuotaExhaustedError":
        return "The subscription's usage limit is reached. Start the run again once it resets.";
      case "RateLimitError":
        return "The translator is taking too many requests. Start the run again in a while.";
      case "AuthenticationError":
      case "InvalidRequestError":
      case "InternalProviderError":
      case "InvalidOutputError":
        // RPGTL's own translators write these descriptions for the page.
        return reason.description ?? reason.message;
      default:
        return reason.message;
    }
  }
  if (StateFolder.isStateFileError(failure))
    return `Couldn't ${failure.operation} ${failure.file}.`;
  if (failure instanceof Games.GameBusyError || failure instanceof EndpointRejectedError)
    return failure.message;
  if (failure instanceof TranslatorUnavailableError)
    return AiError.isAiError(failure.cause)
      ? failureMessage(failure.cause)
      : "The translator couldn't start. RPGTL's log says why.";
  return unexpected;
};

/** The translator, models and settings a run with `settings` answers with. */
const runModels = (
  settings: TranslationSettings,
  model: string,
  glossaryModel: string,
): RunModels => {
  switch (settings.translator) {
    case "ollama":
      return {
        translator: settings.translator,
        model,
        glossaryModel,
        numCtx,
        sampling: settings.sampling,
        retrySampling: retrySampling(model, settings.sampling),
        effort: settings.effort,
      };
    case "claude":
      return {
        translator: settings.translator,
        model,
        glossaryModel,
        effort: settings.effort,
        glossaryEffort: settings.glossaryEffort,
      };
    case "codex":
      return {
        translator: settings.translator,
        model,
        glossaryModel,
        effort: settings.effort,
        glossaryEffort: settings.glossaryEffort,
      };
  }
};

/**
 * Translation runs, one per game at a time, each a fiber that `stop` interrupts. A run holds its
 * game while it runs, saves the catalog after each batch and writes its log as it goes.
 */
export class Runs extends Context.Service<
  Runs,
  {
    /** The game's current or last run since RPGTL started. */
    readonly status: (
      id: string,
    ) => Effect.Effect<Option.Option<RunStatus>, Games.GameNotInspectedError>;
    /**
     * Starts translating the game's untranslated entries with the saved settings once the run's
     * turn comes, and gives the run's first status. Fails while the game's last run hasn't ended.
     */
    readonly start: (
      id: string,
      kind: RunKind,
    ) => Effect.Effect<
      RunStatus,
      Games.GameNotInspectedError | Games.GameBusyError | StateFolder.StateFileError
    >;
    /**
     * The game's current or last run, none before its first since RPGTL started, then each change
     * to it and each later run, until the stream is closed.
     */
    readonly changes: (
      id: string,
    ) => Effect.Effect<Stream.Stream<Option.Option<RunStatus>>, Games.GameNotInspectedError>;
    /** Stops the game's run, keeping what it saved, and gives its status once it has ended. */
    readonly stop: (
      id: string,
    ) => Effect.Effect<Option.Option<RunStatus>, Games.GameNotInspectedError>;
  }
>()("@rpgtl/server/translation/Runs") {}

const make = Effect.gen(function* () {
  const games = yield* Games.Games;
  const catalogs = yield* Catalogs.Catalogs;
  const folder = yield* StateFolder.StateFolder;
  const runLogs = yield* RunLogs.RunLogs;
  const runKinds = yield* RunKinds.RunKinds;
  const savedSettings = yield* Settings.Settings;
  // What the translators need to reach their models, captured so each run can use them.
  const context = yield* Effect.context<TranslatorServices>();
  const fibers = yield* FiberMap.make<string>();
  // A run that waits holds nothing between the check for a run of its game and its fiber's start,
  // so starts go one at a time.
  const starts = yield* Semaphore.make(1);
  const statuses = yield* SubscriptionRef.make(
    new Map<string, SubscriptionRef.SubscriptionRef<RunStatus>>(),
  );

  const status = Effect.fn("Runs.status")(function* (id: string) {
    yield* games.get(id);
    const run = Option.fromUndefinedOr((yield* SubscriptionRef.get(statuses)).get(id));
    if (Option.isNone(run)) return Option.none<RunStatus>();
    return Option.some(yield* SubscriptionRef.get(run.value));
  });

  const changes = Effect.fn("Runs.changes")(function* (id: string) {
    yield* games.get(id);
    return SubscriptionRef.changes(statuses).pipe(
      Stream.map((runs) => runs.get(id)),
      Stream.changesWith((a, b) => a === b),
      Stream.switchMap((run) =>
        run === undefined
          ? Stream.make(Option.none<RunStatus>())
          : Stream.map(SubscriptionRef.changes(run), Option.some),
      ),
    );
  });

  /** The run itself, from the catalog it starts with to the end of its log. */
  const run = Effect.fn("Runs.run")(function* ({
    catalog,
    kind,
    translator,
    current,
    missing,
    names,
    log,
    started,
    models,
  }: {
    readonly catalog: Catalog;
    readonly kind: RunKind;
    readonly translator: Effect.Success<ReturnType<typeof translatorFor>>;
    readonly current: SubscriptionRef.SubscriptionRef<RunStatus>;
    readonly missing: ReadonlySet<string>;
    /** Of `missing`, the names. */
    readonly names: ReadonlySet<string>;
    readonly log: RunLogs.RunLogWriter;
    /** When the run started, as its log and the entries it translates say. */
    readonly started: string;
    readonly models: RunModels;
  }) {
    const id = catalog.game.id;
    const draft = new CatalogDraft(catalog, yield* catalogs.imageLimits(id), started);
    const saves = yield* Semaphore.make(1);
    // Saves the draft as it is when the save starts, so an earlier save never overwrites a later;
    // the status counts what the file holds, so Stop can't come between the two.
    const save = saves.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const marked = withRunMarks(draft.catalog, { started, models });
          yield* catalogs.write(marked);
          const translated = marked.entries.filter((entry) => entryTranslation(entry));
          const done = translated.filter((entry) => missing.has(entry.id)).length;
          const failed = draft.failed;
          yield* SubscriptionRef.update(current, (now) => ({
            ...now,
            done,
            names: {
              total: names.size,
              done: translated.filter((entry) => names.has(entry.id)).length,
              failed: failed.filter((failedId) => names.has(failedId)).length,
            },
            translated: translated.length,
            failed,
            left: now.total - done - failed.length,
          }));
        }),
      ),
    );
    const report = RunReport.of({
      step: Effect.fn("RunReport.step")(function* (step: string | undefined) {
        yield* SubscriptionRef.update(current, (now) =>
          now.phase._tag === "Running"
            ? { ...now, phase: { _tag: "Running" as const, ...(step !== undefined && { step }) } }
            : now,
        );
      }),
      textPass: SubscriptionRef.update(current, (now) => ({ ...now, pass: "text" as const })),
      warn: Effect.fn("RunReport.warn")(function* (message: string) {
        const added = yield* SubscriptionRef.modify(current, (now) =>
          now.warnings.includes(message)
            ? [false, now]
            : [true, { ...now, warnings: [...now.warnings, message] }],
        );
        if (added) yield* log.write({ type: "warning", message }).pipe(Effect.orDie);
      }),
      request: Effect.fn("RunReport.request")(function* (line) {
        yield* log.write({ type: "request", ...line }).pipe(Effect.orDie);
      }),
      ask: Effect.fn("RunReport.ask")(function* (line) {
        yield* log.write({ type: "ask", ...line }).pipe(Effect.orDie);
      }),
      progress: save,
    });

    return yield* Effect.gen(function* () {
      yield* translateCatalog(draft, translator, kind);
      yield* save;
    }).pipe(Effect.provideService(RunReport, report));
  });

  /** Ends the run's status and its log with how it ended. */
  const end = Effect.fn("Runs.end")(function* (
    current: SubscriptionRef.SubscriptionRef<RunStatus>,
    /** None when the run ended before its log was opened, such as while it waited. */
    log: Option.Option<RunLogs.RunLogWriter>,
    exit: Exit.Exit<unknown, unknown>,
  ) {
    const phase = endedPhase(exit, runFailure);
    if (Exit.isFailure(exit) && phase._tag === "Failed")
      yield* Option.exists(Cause.findErrorOption(exit.cause), isExpected)
        ? Effect.logWarning(`A translation run stopped: ${phase.error}`)
        : Effect.logWarning("A translation run failed.", exit.cause);
    const now = yield* SubscriptionRef.get(current);
    // The end line goes first, so the log is complete once the status says the run ended.
    if (Option.isSome(log))
      yield* log.value
        .write({
          type: "end",
          translated: now.done,
          failed: [...now.failed],
          stopped: phase._tag === "Stopped",
          ...(phase._tag === "Failed" && { error: phase.error }),
        })
        .pipe(
          Effect.catchTags({
            StateFileError: (failure) => Effect.logWarning(failure.message, failure.cause),
          }),
        );
    yield* SubscriptionRef.update(current, (last) => ({ ...last, phase }));
  });

  /** Holds the game for its run and gives the run's status once it goes. */
  const begin = Effect.fn("Runs.begin")(function* (id: string, kind: RunKind) {
    yield* games.hold(id);
    const catalog = yield* catalogs.get(id);
    const missing = new Set(
      catalog.entries
        .filter((entry) => !entryTranslation(entry) && (kind === "translate" || isNameEntry(entry)))
        .map((entry) => entry.id),
    );
    const names = new Set(
      catalog.entries
        .filter((entry) => missing.has(entry.id) && isNameEntry(entry))
        .map((entry) => entry.id),
    );
    const going: RunStatus = {
      kind,
      phase: { _tag: "Running" },
      total: missing.size,
      done: 0,
      pass: "names",
      names: { total: names.size, done: 0, failed: 0 },
      translated: catalog.entries.filter((entry) => entryTranslation(entry)).length,
      failed: [],
      left: missing.size,
      warnings: [],
    };
    return { catalog, missing, names, going };
  });

  /** Readies the translator with `settings` and runs it on the held game. */
  const translate = Effect.fn("Runs.translate")(function* (
    kind: RunKind,
    settings: TranslationSettings,
    { catalog, missing, names }: Effect.Success<ReturnType<typeof begin>>,
    current: SubscriptionRef.SubscriptionRef<RunStatus>,
    opened: Ref.Ref<Option.Option<RunLogs.RunLogWriter>>,
  ) {
    const id = catalog.game.id;
    const started = DateTime.formatIso(yield* DateTime.now);
    const translator = yield* translatorFor(settings, {
      log: `${folder.root}/${gameFiles(id).logs}/llama-server-${fileTime(started)}.log`,
    }).pipe(
      Effect.catchTags({
        AiError: (cause) => Effect.fail(new TranslatorUnavailableError({ cause })),
        ConfigError: (cause) => Effect.fail(new TranslatorUnavailableError({ cause })),
        PlatformError: (cause) => Effect.fail(new TranslatorUnavailableError({ cause })),
      }),
    );
    // The run starts from a backup of the catalog as it was.
    yield* catalogs.save(catalog);
    const models = runModels(settings, translator.text.model, translator.names.model);
    const log = yield* runLogs.open(id, {
      ...models,
      ...(settings.translator === "ollama" &&
        settings.expertLayersInRam !== undefined && {
          expertLayersInRam: settings.expertLayersInRam,
        }),
      started,
      kind,
      entries: missing.size,
    });
    yield* Ref.set(opened, Option.some(log));
    yield* run({ catalog, kind, translator, current, missing, names, log, started, models });
  });

  const start = Effect.fn("Runs.start")(function* (id: string, kind: RunKind) {
    const game = yield* games.get(id);
    if (yield* FiberMap.has(fibers, id)) return yield* new Games.GameBusyError({ id });
    const listed = (yield* catalogs.list).find((each) => each.id === id);
    const title = listed?.titleTranslation ?? game.title;
    const settings = translationSettings(yield* savedSettings.get);
    // The run's scope keeps the game listed and the run's place in the queue, then holds the game
    // and the translator's models until the run ends.
    const scope = yield* Scope.make();
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* games.keep(id);
        const turn = yield* runKinds.translation(
          { id, title },
          { local: settings.translator === "ollama" },
        );
        const waitingFor = yield* turn.waitingFor;
        // A run whose turn has come holds the game before the answer, so a game held by
        // something else refuses the run instead of failing it.
        const begun = Arr.isReadonlyArrayNonEmpty(waitingFor)
          ? ({ _tag: "Waiting", for: waitingFor } as const)
          : ({ _tag: "Begun", ...(yield* begin(id, kind)) } as const);
        const first =
          begun._tag === "Waiting"
            ? ({
                kind,
                phase: begun,
                total: 0,
                done: 0,
                pass: "names",
                names: { total: 0, done: 0, failed: 0 },
                translated: 0,
                failed: [],
                left: 0,
                warnings: [],
              } satisfies RunStatus)
            : begun.going;
        const current = yield* SubscriptionRef.make(first);
        yield* SubscriptionRef.update(statuses, (runs) => new Map(runs).set(id, current));
        const log = yield* Ref.make(Option.none<RunLogs.RunLogWriter>());
        const turnCome: Effect.Effect<
          Effect.Success<ReturnType<typeof begin>>,
          Effect.Error<ReturnType<typeof begin>>,
          Scope.Scope
        > = begun._tag === "Begun"
          ? Effect.succeed(begun)
          : turn
              .ready((now) =>
                SubscriptionRef.update(current, (last) => ({
                  ...last,
                  phase: { _tag: "Waiting" as const, for: now },
                })),
              )
              .pipe(
                Effect.andThen(begin(id, kind)),
                Effect.tap((started) => SubscriptionRef.set(current, started.going)),
              );
        yield* FiberMap.run(
          fibers,
          id,
          turnCome.pipe(
            Effect.flatMap((ready) => translate(kind, settings, ready, current, log)),
            Scope.provide(scope),
            Effect.provideContext(context),
            Effect.onExit((exit) =>
              SubscriptionRef.update(current, (now) =>
                now.phase._tag === "Waiting" ? now : { ...now, phase: { _tag: "Ending" as const } },
              ).pipe(
                Effect.andThen(Scope.close(scope, exit)),
                Effect.andThen(
                  Effect.flatMap(Ref.get(log), (opened) => end(current, opened, exit)),
                ),
              ),
            ),
          ),
        );
        return first;
      }).pipe(
        Scope.provide(scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      ),
    );
  }, starts.withPermits(1));

  // A run's fiber exists only once its start has returned, so a Stop waits for a start in progress.
  const stop = Effect.fn("Runs.stop")(function* (id: string) {
    yield* games.get(id);
    yield* starts.withPermits(1)(FiberMap.remove(fibers, id));
    return yield* status(id);
  });

  return Runs.of({ status, changes, start, stop });
});

export const layer = Layer.effect(Runs, make);
