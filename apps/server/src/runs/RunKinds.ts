import type { QueuedRun, RunGame, WaitingFor } from "@rpgtl/contracts";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/** Images are read, or wait to be, so the reader's files can't be deleted now. */
export class ReadingImagesError extends Schema.TaggedError<ReadingImagesError>()(
  "ReadingImagesError",
  {},
) {
  override get message() {
    return "Images are being read, or wait to be.";
  }
}

/** The image reader's files are being deleted. */
export class ReaderRemovingError extends Schema.TaggedError<ReaderRemovingError>()(
  "ReaderRemovingError",
  {},
) {
  override get message() {
    return "The image reader is being removed.";
  }
}

/** A run's place in the queue, until its scope closes. */
export interface Turn {
  /** The runs it waits for now; empty once its turn has come. */
  readonly waitingFor: Effect.Effect<ReadonlyArray<WaitingFor>>;
  /** Waits for the turn, telling `waiting` each change in what it waits for meanwhile. */
  readonly ready: (
    waiting: (now: Arr.NonEmptyReadonlyArray<WaitingFor>) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
}

interface Ticket extends WaitingFor {
  readonly number: number;
  /** Translates with a local model, so it can't go beside another run that does. */
  readonly local: boolean;
}

interface Queue {
  readonly going: ReadonlyArray<Ticket>;
  /** In the order they were asked for. */
  readonly waiting: ReadonlyArray<Ticket>;
  readonly removingReader: boolean;
  readonly next: number;
}

/** Translation runs go on together unless both use a local model; image reading goes on alone. */
const conflict = (a: Ticket, b: Ticket) =>
  a.kind === "imageReading" || b.kind === "imageReading" || (a.local && b.local);

/**
 * What the ticket waits for: the runs going that it can't go beside, or else the runs waiting
 * ahead of it that it can't go beside, which keep the queue's order.
 */
const waitingFor = (queue: Queue, number: number): ReadonlyArray<WaitingFor> => {
  const at = queue.waiting.findIndex((each) => each.number === number);
  const ticket = queue.waiting[at];
  if (ticket === undefined) return [];
  const going = queue.going.filter((each) => conflict(each, ticket));
  const ahead = going.length > 0 ? going : queue.waiting.slice(0, at);
  return ahead.filter((each) => conflict(each, ticket)).map(({ kind, game }) => ({ kind, game }));
};

/** Starts the waiting runs that wait for nothing, in the order they were asked for. */
const advance = (queue: Queue): Queue =>
  queue.waiting.reduce<Queue>(
    (now, ticket) =>
      waitingFor(now, ticket.number).length > 0
        ? now
        : {
            ...now,
            going: [...now.going, ticket],
            waiting: now.waiting.filter((each) => each.number !== ticket.number),
          },
    queue,
  );

const sameRuns = (a: ReadonlyArray<WaitingFor>, b: ReadonlyArray<WaitingFor>) =>
  a.length === b.length &&
  a.every((each, index) => each.kind === b[index]?.kind && each.game.id === b[index]?.game.id);

/**
 * Translation runs and image reading take turns across all games, in the order they were asked
 * for, since both load models into the same memory. Translation runs go on together, except two
 * with a local model; images are read in one game at a time, as all games share one image reader,
 * and never while the reader's files are being deleted. A translation run asked for after an
 * image reading waits behind it.
 */
export class RunKinds extends Context.Service<
  RunKinds,
  {
    /** Every run in the queue now and after each change, the going ones first. */
    readonly changes: Stream.Stream<ReadonlyArray<QueuedRun>>;
    /** Queues a translation run of the game until the scope closes. */
    readonly translation: (
      game: RunGame,
      translator: { readonly local: boolean },
    ) => Effect.Effect<Turn, never, Scope.Scope>;
    /** Queues reading the game's images until the scope closes. */
    readonly imageReading: (game: RunGame) => Effect.Effect<Turn, ReaderRemovingError, Scope.Scope>;
    /**
     * Keeps image reading out while the reader's files are deleted, until the scope closes; fails
     * at once while images are read or wait to be, or another removal runs.
     */
    readonly readerRemoval: Effect.Effect<
      void,
      ReadingImagesError | ReaderRemovingError,
      Scope.Scope
    >;
  }
>()("@rpgtl/server/runs/RunKinds") {}

const make = Effect.gen(function* () {
  const queue = yield* SubscriptionRef.make<Queue>({
    going: [],
    waiting: [],
    removingReader: false,
    next: 0,
  });

  const enter = <E>(
    kind: WaitingFor["kind"],
    game: RunGame,
    local: boolean,
    refuse: (now: Queue) => Option.Option<E>,
  ) =>
    Effect.acquireRelease(
      SubscriptionRef.modifyEffect(queue, (now) =>
        Option.match(refuse(now), {
          onSome: Effect.fail,
          onNone: () =>
            Effect.succeed([
              now.next,
              advance({
                ...now,
                waiting: [...now.waiting, { kind, game, local, number: now.next }],
                next: now.next + 1,
              }),
            ] as const),
        }),
      ),
      (number) =>
        SubscriptionRef.update(queue, (now) =>
          advance({
            ...now,
            going: now.going.filter((each) => each.number !== number),
            waiting: now.waiting.filter((each) => each.number !== number),
          }),
        ),
    ).pipe(
      Effect.map((number): Turn => ({
        waitingFor: Effect.map(SubscriptionRef.get(queue), (now) => waitingFor(now, number)),
        ready: (waiting) =>
          SubscriptionRef.changes(queue).pipe(
            Stream.map((now) => waitingFor(now, number)),
            Stream.changesWith(sameRuns),
            Stream.takeUntil((now) => now.length === 0),
            Stream.runForEach((now) =>
              Arr.isReadonlyArrayNonEmpty(now) ? waiting(now) : Effect.void,
            ),
          ),
      })),
    );

  const translation = Effect.fn("RunKinds.translation")(function* (
    game: RunGame,
    { local }: { readonly local: boolean },
  ) {
    return yield* enter("translation", game, local, () => Option.none());
  });

  const imageReading = Effect.fn("RunKinds.imageReading")(function* (game: RunGame) {
    return yield* enter("imageReading", game, false, (now) =>
      now.removingReader ? Option.some(new ReaderRemovingError()) : Option.none(),
    );
  });

  const readerRemoval = Effect.acquireRelease(
    SubscriptionRef.updateEffect(
      queue,
      (now): Effect.Effect<Queue, ReadingImagesError | ReaderRemovingError> => {
        if ([...now.going, ...now.waiting].some((each) => each.kind === "imageReading"))
          return Effect.fail(new ReadingImagesError());
        if (now.removingReader) return Effect.fail(new ReaderRemovingError());
        return Effect.succeed({ ...now, removingReader: true });
      },
    ),
    () => SubscriptionRef.update(queue, (now) => ({ ...now, removingReader: false })),
  ).pipe(Effect.withSpan("RunKinds.readerRemoval"));

  const changes = SubscriptionRef.changes(queue).pipe(
    Stream.map((now) =>
      [...now.going, ...now.waiting].map(({ kind, game, number }): QueuedRun => ({
        kind,
        game,
        waitingFor: waitingFor(now, number),
      })),
    ),
    Stream.changesWith(
      (a, b) =>
        a.length === b.length &&
        a.every((each, index) => {
          const other = b[index];
          return (
            other !== undefined &&
            sameRuns([each], [other]) &&
            sameRuns(each.waitingFor, other.waitingFor)
          );
        }),
    ),
  );

  return RunKinds.of({ changes, translation, imageReading, readerRemoval });
});

export const layer = Layer.effect(RunKinds, make);
