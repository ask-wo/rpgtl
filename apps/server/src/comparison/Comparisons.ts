import {
  type Catalog,
  type ComparedSetup,
  Comparison,
  type ComparisonSetup,
  type RunLogLine,
  Samples,
  fileTime,
  gameFiles,
} from "@rpgtl/contracts";
import { CatalogDraft, entryTranslation, pickSamples, sampleCatalog } from "@rpgtl/domain";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Catalogs from "../games/Catalogs.ts";
import type * as Games from "../games/Games.ts";
import * as FreeMemory from "../localModels/FreeMemory.ts";
import * as StateFolder from "../state/StateFolder.ts";
import { RunReport } from "../translation/RunReport.ts";
import { runFailure } from "../translation/Runs.ts";
import { translateCatalog } from "../translation/translate.ts";
import { translatorFor, type TranslatorServices } from "../translation/translators.ts";
import { comparisonHtml } from "./report.ts";

/** What a comparison tells its caller as it goes. */
export type ComparisonEvent = Data.TaggedEnum<{
  /** A setup's run on the sample begins. */
  Started: { readonly label: string; readonly entries: number };
  /** A setup's run ended, and `report`, the HTML file, now shows it. */
  Ended: { readonly setup: ComparedSetup; readonly report: string };
}>;
export const ComparisonEvent = Data.taggedEnum<ComparisonEvent>();

export class Comparisons extends Context.Service<
  Comparisons,
  {
    /**
     * Runs each setup on the game's sample in turn, as a translation run would, and rewrites the
     * report after each.
     */
    readonly compare: (
      id: string,
      setups: ReadonlyArray<ComparisonSetup>,
    ) => Effect.Effect<
      Stream.Stream<ComparisonEvent, StateFolder.StateFileError>,
      Games.GameNotInspectedError | StateFolder.StateFileError
    >;
  }
>()("@rpgtl/server/comparison/Comparisons") {}

const make = Effect.gen(function* () {
  const catalogs = yield* Catalogs.Catalogs;
  const folder = yield* StateFolder.StateFolder;
  const memory = yield* FreeMemory.FreeMemory;
  // What the translators need to reach their models, captured so each setup can use them.
  const context = yield* Effect.context<TranslatorServices>();

  /** The game's saved samples, or new ones, saved for the next comparison. */
  const samplesOf = Effect.fn("Comparisons.samplesOf")(function* (catalog: Catalog) {
    const file = gameFiles(catalog.game.id).samples;
    const saved = yield* folder.read(file, Samples);
    if (Option.isSome(saved)) return saved.value;
    const picked = pickSamples(catalog);
    yield* folder.write(file, Samples, picked);
    return picked;
  });

  /**
   * Watches free VRAM until the scope closes. `used` gives the most the run took beyond what was
   * in use when it started, in MiB, when nvidia-smi answers.
   */
  const watchVram = Effect.fn("Comparisons.watchVram")(function* () {
    const before = yield* memory.vram.pipe(
      Effect.asSome,
      Effect.catchTags({ FreeMemoryError: () => Effect.succeedNone }),
    );
    if (Option.isNone(before)) return { used: Effect.succeedNone };
    const lowest = yield* Ref.make(before.value);
    yield* memory.vram.pipe(
      Effect.flatMap((free) => Ref.update(lowest, (low) => Math.min(low, free))),
      // A reading nvidia-smi misses leaves the lowest as it was.
      Effect.catchTags({ FreeMemoryError: () => Effect.void }),
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.forkScoped,
    );
    return {
      used: Ref.get(lowest).pipe(
        Effect.map((low) => Option.some(Math.round((before.value - low) / 2 ** 20))),
      ),
    };
  });

  /** One setup's run on the sample, with the lines its log would hold. */
  const runSetup = Effect.fn("Comparisons.runSetup")(function* (
    catalog: Catalog,
    draft: CatalogDraft,
    setup: ComparisonSetup,
    llamaLog: string,
  ) {
    const lines = yield* Ref.make<ReadonlyArray<RunLogLine>>([]);
    const now = Effect.map(DateTime.now, DateTime.formatIso);
    const append = (line: RunLogLine) => Ref.update(lines, (all) => [...all, line]);
    const report = RunReport.of({
      step: Effect.fn("RunReport.step")(function* () {}),
      warn: Effect.fn("RunReport.warn")(function* (message: string) {
        const at = yield* now;
        yield* Ref.update(lines, (all): ReadonlyArray<RunLogLine> =>
          all.some((line) => line.type === "warning" && line.message === message)
            ? all
            : [...all, { type: "warning", at, message }],
        );
      }),
      request: Effect.fn("RunReport.request")(function* (line) {
        yield* append({ type: "request", at: yield* now, ...line });
      }),
      ask: Effect.fn("RunReport.ask")(function* (line) {
        yield* append({ type: "ask", at: yield* now, ...line });
      }),
      progress: Effect.void,
    });
    const started = yield* Clock.currentTimeMillis;
    const { exit, vramMiB } = yield* Effect.scoped(
      Effect.gen(function* () {
        const vram = yield* watchVram();
        const ended = yield* Effect.exit(
          Effect.gen(function* () {
            // Each answer then depends only on its own request, so setups and reruns compare fairly.
            const translator = yield* translatorFor(setup.settings, {
              log: llamaLog,
              promptCache: false,
            });
            yield* translateCatalog(
              draft,
              setup.batchSize === undefined
                ? translator
                : { ...translator, batchSize: setup.batchSize, sceneSize: setup.batchSize },
              "translate",
            );
          }),
        );
        return { exit: ended, vramMiB: yield* vram.used };
      }),
    ).pipe(Effect.provideService(RunReport, report), Effect.provide(context));
    // Stopping the comparison stops it, instead of ending only this setup's run.
    if (Exit.hasInterrupts(exit)) return yield* Effect.interrupt;
    const ms = (yield* Clock.currentTimeMillis) - started;
    const error = Exit.isFailure(exit) ? runFailure(exit.cause) : undefined;
    if (error !== undefined) yield* Effect.logDebug("A compared setup failed.", exit);
    const at = yield* now;
    const end: RunLogLine = {
      type: "end",
      at,
      translated: draft.entries.filter((entry) => entryTranslation(entry)).length,
      failed: [...draft.failed],
      stopped: false,
      ...(error !== undefined && { error }),
    };
    return {
      ...setup,
      lines: [...(yield* Ref.get(lines)), end],
      ms,
      ...Option.match(vramMiB, { onNone: () => ({}), onSome: (mib) => ({ vramMiB: mib }) }),
    } satisfies ComparedSetup;
  });

  const compare = Effect.fn("Comparisons.compare")(function* (
    id: string,
    setups: ReadonlyArray<ComparisonSetup>,
  ) {
    const catalog = yield* catalogs.get(id);
    const samples = yield* samplesOf(catalog);
    const sample = sampleCatalog(catalog, samples);
    const limits = yield* catalogs.imageLimits(id);
    const stamp = fileTime(DateTime.formatIso(yield* DateTime.now));
    const files = gameFiles(id);
    const name = `${files.reports}/compare-${stamp}`;
    const llamaLog = `${folder.root}/${files.logs}/compare-${stamp}-llama-server.log`;
    const done = yield* Ref.make<ReadonlyArray<ComparedSetup>>([]);
    const save = Effect.fn("Comparisons.save")(function* (setup: ComparedSetup) {
      const comparison: Comparison = {
        game: { id, title: catalog.game.title, engine: catalog.game.engine },
        samples,
        sample: { entries: sample.entries, glossary: sample.glossary },
        setups: yield* Ref.updateAndGet(done, (all) => [...all, setup]),
      };
      yield* folder.write(`${name}.json`, Comparison, comparison);
      yield* folder.writeBytes(
        `${name}.html`,
        new TextEncoder().encode(comparisonHtml(comparison)),
      );
      return ComparisonEvent.Ended({ setup, report: `${folder.root}/${name}.html` });
    });
    return Stream.fromIterable(setups).pipe(
      Stream.flatMap((setup) =>
        Stream.concat(
          Stream.succeed(
            ComparisonEvent.Started({ label: setup.label, entries: sample.entries.length }),
          ),
          Stream.fromEffect(
            Effect.map(DateTime.now, DateTime.formatIso).pipe(
              Effect.flatMap((started) =>
                runSetup(catalog, new CatalogDraft(sample, limits, started), setup, llamaLog),
              ),
              Effect.flatMap(save),
            ),
          ),
        ),
      ),
    );
  });

  return Comparisons.of({ compare });
});

export const layer = Layer.effect(Comparisons, make);
