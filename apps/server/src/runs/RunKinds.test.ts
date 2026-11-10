import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RunKinds from "./RunKinds.ts";

const meadow = { id: "meadow", title: "Meadow Quest" };
const harbor = { id: "harbor", title: "Harbor Tales" };
const lantern = { id: "lantern", title: "Lantern Road" };
const cloud = { local: false };
const local = { local: true };

/** Queues a run in a scope of its own, which the test closes to end it. */
const queued = Effect.fn("queued")(function* <E>(
  enter: Effect.Effect<RunKinds.Turn, E, Scope.Scope>,
) {
  const scope = yield* Scope.make();
  const turn = yield* Scope.provide(enter, scope);
  return { turn, end: Scope.close(scope, Exit.void) };
});

it.effect("translation runs go on together, and image reading waits until all have ended", () =>
  Effect.gen(function* () {
    const runKinds = yield* RunKinds.RunKinds;
    const first = yield* queued(runKinds.translation(meadow, cloud));
    const second = yield* queued(runKinds.translation(harbor, cloud));
    assert.deepStrictEqual(yield* first.turn.waitingFor, []);
    assert.deepStrictEqual(yield* second.turn.waitingFor, []);

    const reading = yield* queued(runKinds.imageReading(lantern));
    assert.deepStrictEqual(yield* reading.turn.waitingFor, [
      { kind: "translation", game: meadow },
      { kind: "translation", game: harbor },
    ]);
    yield* first.end;
    assert.deepStrictEqual(yield* reading.turn.waitingFor, [{ kind: "translation", game: harbor }]);
    yield* second.end;
    assert.deepStrictEqual(yield* reading.turn.waitingFor, []);
  }).pipe(Effect.provide(RunKinds.layer)),
);

it.effect("translation runs with a local model take turns, and go on beside other runs", () =>
  Effect.gen(function* () {
    const runKinds = yield* RunKinds.RunKinds;
    const first = yield* queued(runKinds.translation(meadow, local));
    const beside = yield* queued(runKinds.translation(harbor, cloud));
    const second = yield* queued(runKinds.translation(lantern, local));
    assert.deepStrictEqual(yield* beside.turn.waitingFor, []);
    assert.deepStrictEqual(yield* second.turn.waitingFor, [{ kind: "translation", game: meadow }]);

    yield* first.end;
    assert.deepStrictEqual(yield* second.turn.waitingFor, []);
  }).pipe(Effect.provide(RunKinds.layer)),
);

it.effect("a run that nothing keeps out goes past a waiting one, and later runs wait for it", () =>
  Effect.gen(function* () {
    const runKinds = yield* RunKinds.RunKinds;
    yield* queued(runKinds.translation(meadow, local));
    yield* queued(runKinds.translation(harbor, local));
    yield* queued(runKinds.translation(lantern, cloud));
    const reading = yield* queued(runKinds.imageReading({ id: "orchard", title: "Orchard" }));
    assert.deepStrictEqual(yield* reading.turn.waitingFor, [
      { kind: "translation", game: meadow },
      { kind: "translation", game: lantern },
    ]);
  }).pipe(Effect.provide(RunKinds.layer)),
);

it.effect("a translation run asked for after an image reading waits behind it", () =>
  Effect.gen(function* () {
    const runKinds = yield* RunKinds.RunKinds;
    const translating = yield* queued(runKinds.translation(meadow, cloud));
    const reading = yield* queued(runKinds.imageReading(harbor));
    const later = yield* queued(runKinds.translation(lantern, cloud));
    assert.deepStrictEqual(yield* later.turn.waitingFor, [{ kind: "imageReading", game: harbor }]);

    yield* translating.end;
    assert.deepStrictEqual(yield* reading.turn.waitingFor, []);
    assert.deepStrictEqual(yield* later.turn.waitingFor, [{ kind: "imageReading", game: harbor }]);
    yield* reading.end;
    assert.deepStrictEqual(yield* later.turn.waitingFor, []);
  }).pipe(Effect.provide(RunKinds.layer)),
);

it.effect("one game reads images at a time, in the order asked for", () =>
  Effect.gen(function* () {
    const runKinds = yield* RunKinds.RunKinds;
    const first = yield* queued(runKinds.imageReading(meadow));
    const second = yield* queued(runKinds.imageReading(harbor));
    const third = yield* queued(runKinds.imageReading(lantern));
    assert.deepStrictEqual(yield* third.turn.waitingFor, [{ kind: "imageReading", game: meadow }]);

    yield* first.end;
    assert.deepStrictEqual(yield* second.turn.waitingFor, []);
    assert.deepStrictEqual(yield* third.turn.waitingFor, [{ kind: "imageReading", game: harbor }]);
  }).pipe(Effect.provide(RunKinds.layer)),
);

it.effect("a run waiting for its turn hears each change and goes on once its turn comes", () =>
  Effect.gen(function* () {
    const runKinds = yield* RunKinds.RunKinds;
    const first = yield* queued(runKinds.translation(meadow, cloud));
    const second = yield* queued(runKinds.translation(harbor, cloud));
    const reading = yield* queued(runKinds.imageReading(lantern));
    const heard: Array<ReadonlyArray<string>> = [];
    const waited = yield* Deferred.make<void>();
    const fiber = yield* reading.turn
      .ready((now) =>
        Effect.andThen(
          Effect.sync(() => heard.push(now.map((each) => each.game.id))),
          Deferred.succeed(waited, undefined),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(waited);

    yield* first.end;
    yield* second.end;
    yield* Fiber.join(fiber);
    assert.deepStrictEqual(heard, [["meadow", "harbor"], ["harbor"]]);
  }).pipe(Effect.provide(RunKinds.layer)),
);

it.effect("a run that stops waiting leaves the queue to the runs behind it", () =>
  Effect.gen(function* () {
    const runKinds = yield* RunKinds.RunKinds;
    const translating = yield* queued(runKinds.translation(meadow, cloud));
    const reading = yield* queued(runKinds.imageReading(harbor));
    const later = yield* queued(runKinds.translation(lantern, cloud));

    yield* reading.end;
    assert.deepStrictEqual(yield* later.turn.waitingFor, []);
    yield* translating.end;
  }).pipe(Effect.provide(RunKinds.layer)),
);

it.effect(
  "removing the reader goes on beside translations and keeps image reading out until it ends",
  () =>
    Effect.gen(function* () {
      const runKinds = yield* RunKinds.RunKinds;
      const translating = yield* queued(runKinds.translation(meadow, cloud));
      const removing = yield* Scope.make();
      yield* Scope.provide(runKinds.readerRemoval, removing);

      assert.strictEqual(
        (yield* Effect.flip(Effect.scoped(runKinds.readerRemoval)))._tag,
        "ReaderRemovingError",
      );
      assert.strictEqual(
        (yield* Effect.flip(Effect.scoped(runKinds.imageReading(harbor))))._tag,
        "ReaderRemovingError",
      );
      yield* translating.end;

      yield* Scope.close(removing, Exit.void);
      yield* queued(runKinds.imageReading(harbor));
    }).pipe(Effect.provide(RunKinds.layer)),
);

it.effect("the reader can't be removed while images are read or wait to be", () =>
  Effect.gen(function* () {
    const runKinds = yield* RunKinds.RunKinds;
    const translating = yield* queued(runKinds.translation(meadow, cloud));
    const reading = yield* queued(runKinds.imageReading(harbor));
    assert.strictEqual(
      (yield* Effect.flip(Effect.scoped(runKinds.readerRemoval)))._tag,
      "ReadingImagesError",
    );
    yield* translating.end;
    assert.strictEqual(
      (yield* Effect.flip(Effect.scoped(runKinds.readerRemoval)))._tag,
      "ReadingImagesError",
    );
    yield* reading.end;
    yield* Effect.scoped(runKinds.readerRemoval);
  }).pipe(Effect.provide(RunKinds.layer)),
);

it.effect("the queue's changes list every run, going first, with what each waits for", () =>
  Effect.gen(function* () {
    const runKinds = yield* RunKinds.RunKinds;
    const now = runKinds.changes.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
    assert.deepStrictEqual(yield* now, []);
    const reading = yield* queued(runKinds.imageReading(meadow));
    yield* queued(runKinds.translation(harbor, cloud));
    assert.deepStrictEqual(yield* now, [
      { kind: "imageReading", game: meadow, waitingFor: [] },
      {
        kind: "translation",
        game: harbor,
        waitingFor: [{ kind: "imageReading", game: meadow }],
      },
    ]);
    yield* reading.end;
    assert.deepStrictEqual(yield* now, [{ kind: "translation", game: harbor, waitingFor: [] }]);
  }).pipe(Effect.provide(RunKinds.layer)),
);
