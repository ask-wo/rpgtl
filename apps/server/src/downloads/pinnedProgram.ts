import type { ProgramName, ProgramStatus } from "@rpgtl/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { userFolder } from "../state/userFolders.ts";
import { makeFetchPinnedArchive, type PinnedArchive } from "./pinnedArchive.ts";

/** A program's release that RPGTL downloads. */
export interface ProgramRelease extends Omit<PinnedArchive, "what"> {
  readonly version: string;
  /** The program in the unpacked folder. */
  readonly program: string;
}

export class ProgramMissingError extends Schema.TaggedError<ProgramMissingError>()(
  "ProgramMissingError",
  { program: Schema.String },
) {
  override get message() {
    return `${this.program} isn't downloaded yet.`;
  }
}

/** A program RPGTL runs games in, downloaded once when the user asks. */
export interface PinnedProgram {
  /** The status now and after each change, until the stream is closed. */
  readonly changes: Stream.Stream<ProgramStatus>;
  /**
   * Starts downloading the program unless it is there, on its way or can't run on this computer,
   * and gives the status. The download goes on in the background until it ends or RPGTL exits.
   */
  readonly download: Effect.Effect<ProgramStatus>;
  /** The program, once it is downloaded. */
  readonly program: Effect.Effect<string, ProgramMissingError>;
}

type Progress =
  | { readonly _tag: "Idle"; readonly error: Option.Option<string> }
  | { readonly _tag: "Downloading"; readonly received: number };

interface Attempt {
  readonly attempt: number;
  readonly now: Progress;
}

/**
 * The pinned `release` of `name` in `<cache>/<cacheName>/` of RPGTL's cache folder
 * (`userFolder("cache")`); `supported` says whether it runs on this computer. Downloads run in the
 * caller's scope, so its end stops them.
 */
export const makePinnedProgram = Effect.fnUntraced(function* (
  name: ProgramName,
  cacheName: string,
  release: ProgramRelease,
  supported: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fetchPinnedArchive = yield* makeFetchPinnedArchive;
  const base = path.join(yield* userFolder("cache"), cacheName);
  const folder = path.join(base, release.version);
  const binary = path.join(folder, release.program);
  const scope = yield* Effect.scope;
  const progress = yield* SubscriptionRef.make<Attempt>({
    attempt: 0,
    now: { _tag: "Idle", error: Option.none() },
  });
  const settle = (now: Progress) => SubscriptionRef.update(progress, (last) => ({ ...last, now }));

  const ready = fs
    .exists(binary)
    .pipe(Effect.catchTags({ PlatformError: () => Effect.succeed(false) }));

  const statusOf = ({ attempt, now }: Attempt) =>
    Effect.map(ready, (isReady): ProgramStatus => ({
      name,
      version: release.version,
      size: release.size,
      folder: base,
      phase: !supported
        ? { _tag: "Unsupported" }
        : isReady
          ? { _tag: "Ready" }
          : now._tag === "Downloading"
            ? now
            : Option.match(now.error, {
                onNone: () => ({ _tag: "Missing" }),
                onSome: (error) => ({ _tag: "Missing", error }),
              }),
      attempt,
    }));

  const status = Effect.flatMap(SubscriptionRef.get(progress), statusOf);
  const changes = SubscriptionRef.changes(progress).pipe(Stream.mapEffect(statusOf));

  const fetchRelease = fetchPinnedArchive({ ...release, what: name }, folder, (bytes) =>
    SubscriptionRef.update(progress, (last) =>
      last.now._tag === "Downloading"
        ? { ...last, now: { ...last.now, received: last.now.received + bytes } }
        : last,
    ),
  ).pipe(
    Effect.matchCauseEffect({
      onSuccess: () => settle({ _tag: "Idle", error: Option.none() }),
      onFailure: (cause) =>
        Effect.gen(function* () {
          const error = Option.getOrUndefined(Cause.findErrorOption(cause));
          if (error) yield* Effect.logWarning(error.message, error.cause);
          else yield* Effect.logError(`The ${name} download stopped.`, cause);
          yield* settle({
            _tag: "Idle",
            error: Option.some(error?.message ?? `The ${name} download stopped. Try again.`),
          });
        }),
    }),
    Effect.withSpan("PinnedProgram.fetchRelease", { attributes: { name } }),
  );

  const download = SubscriptionRef.updateEffect(progress, (last) =>
    Effect.gen(function* () {
      if (!supported || last.now._tag === "Downloading" || (yield* ready)) return last;
      yield* Effect.forkIn(fetchRelease, scope);
      return { attempt: last.attempt + 1, now: { _tag: "Downloading", received: 0 } } as const;
    }),
  ).pipe(Effect.andThen(status), Effect.withSpan("PinnedProgram.download"));

  const program = ready.pipe(
    Effect.filterOrFail(
      (found) => supported && found,
      () => new ProgramMissingError({ program: name }),
    ),
    Effect.as(binary),
    Effect.withSpan("PinnedProgram.program"),
  );

  return { changes, download, program } satisfies PinnedProgram;
});
