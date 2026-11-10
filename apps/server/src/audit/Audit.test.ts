import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Catalogs from "../games/Catalogs.ts";
import { folderWith, mvGame } from "../testUtils/gameFolder.ts";
import { opened, servicesWith } from "../testUtils/state.ts";
import * as RunLogs from "../translation/RunLogs.ts";
import * as Audit from "./Audit.ts";

const Services = Audit.layer.pipe(
  Layer.provideMerge(RunLogs.layer),
  Layer.provideMerge(servicesWith({})),
  Layer.provideMerge(NodeServices.layer),
);

/** An inspected copy of `mvGame` with a run log for each start time, oldest first. */
const gameWithRuns = Effect.fnUntraced(function* (starts: ReadonlyArray<string>) {
  const { game } = yield* opened((yield* Catalogs.Catalogs).inspect(yield* folderWith(mvGame)));
  const logs = yield* RunLogs.RunLogs;
  for (const started of starts) {
    const log = yield* logs.open(game.id, {
      started,
      translator: "ollama",
      kind: "translate",
      model: started,
      glossaryModel: "m",
      numCtx: 4096,
      sampling: "temperature-0",
      entries: 3,
    });
    yield* log.write({ type: "end", translated: 0, failed: [], stopped: false });
  }
  return game.id;
});

const models = (report: {
  readonly run?: { readonly summary: { readonly start?: { readonly model: string } } };
}) => report.run?.summary.start?.model;

it.effect("the audit reads the newest run log, the one before it, or a log file it is given", () =>
  Effect.gen(function* () {
    const audit = yield* Audit.Audit;
    const id = yield* gameWithRuns(["2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z"]);
    const newest = yield* audit.report(id, { log: { _tag: "Newest" }, compare: true });
    assert.strictEqual(models(newest), "2026-11-02T00:00:00.000Z");
    assert.strictEqual(newest.comparison?.before.start?.model, "2026-11-01T00:00:00.000Z");
    const previous = yield* audit.report(id, { log: { _tag: "Previous" }, compare: false });
    assert.strictEqual(models(previous), "2026-11-01T00:00:00.000Z");
    const file = previous.run?.summary.file ?? "";
    const given = yield* audit.report(id, { log: { _tag: "File", file }, compare: false });
    assert.strictEqual(models(given), "2026-11-01T00:00:00.000Z");

    const nothingBefore = yield* Effect.flip(
      audit.report(id, { log: { _tag: "Previous" }, compare: true }),
    );
    assert.deepInclude(nothingBefore, { _tag: "NoRunLogError", missing: "before" });
  }).pipe(Effect.provide(Services)),
);

it.effect("a game without run logs is audited without a run, and has no earlier run", () =>
  Effect.gen(function* () {
    const audit = yield* Audit.Audit;
    const id = yield* gameWithRuns([]);
    const report = yield* audit.report(id, { log: { _tag: "Newest" }, compare: false });
    assert.isUndefined(report.run);
    const previous = yield* Effect.flip(
      audit.report(id, { log: { _tag: "Previous" }, compare: false }),
    );
    assert.deepInclude(previous, { _tag: "NoRunLogError", missing: "previous" });
  }).pipe(Effect.provide(Services)),
);

it.effect("coverage and logic search the inspected game's own files", () =>
  Effect.gen(function* () {
    const audit = yield* Audit.Audit;
    const id = yield* gameWithRuns([]);
    // The plugin's sound setting is a file name, which no entry covers.
    assert.deepStrictEqual(yield* audit.coverage(id), [
      { where: "plugins.js Pic", count: 1, examples: ["合成物品"] },
    ]);
    assert.deepStrictEqual(yield* audit.logic(id), []);
  }).pipe(Effect.provide(Services)),
);
