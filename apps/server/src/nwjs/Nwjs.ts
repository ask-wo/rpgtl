import type { ProgramStatus } from "@rpgtl/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { makeFetchPinnedArchive } from "../downloads/pinnedArchive.ts";
import { userFolder } from "../state/userFolders.ts";

interface Release {
  readonly version: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
  /** The folder the archive holds. */
  readonly folder: string;
  /** The NW.js program in that folder. */
  readonly program: string;
}

const windowsRelease: Release = {
  version: "v0.117.0",
  url: "https://dl.nwjs.io/v0.117.0/nwjs-v0.117.0-win-x64.zip",
  size: 215_951_728,
  sha256: "0d8356b4ac1550a72a58ec86a5aa44581ce08919617f8d593a3282a3cfa7e397",
  folder: "nwjs-v0.117.0-win-x64",
  program: "nw.exe",
};

const linuxRelease: Release = {
  version: "v0.117.0",
  url: "https://dl.nwjs.io/v0.117.0/nwjs-v0.117.0-linux-x64.tar.gz",
  size: 195_658_527,
  sha256: "2881ed1f3a9031d58d8fa0f0714d0bdac7b45d52bdec095cd72aa4f31e08debf",
  folder: "nwjs-v0.117.0-linux-x64",
  program: "nw",
};

/** The NW.js build RPGTL runs games in; tests serve a small one of their own. */
export const NwjsRelease = Context.Reference<Release>("@rpgtl/server/nwjs/NwjsRelease", {
  defaultValue: () => (process.platform === "win32" ? windowsRelease : linuxRelease),
});

export class ProgramMissingError extends Schema.TaggedError<ProgramMissingError>()(
  "ProgramMissingError",
  {},
) {
  override get message() {
    return "NW.js isn't downloaded yet.";
  }
}

/**
 * The pinned NW.js in `nwjs/` of RPGTL's cache folder (`userFolder("cache")`), downloaded once
 * when the user asks.
 */
export class Nwjs extends Context.Service<
  Nwjs,
  {
    /** The status now and after each change, until the stream is closed. */
    readonly changes: Stream.Stream<ProgramStatus>;
    /**
     * Starts downloading NW.js unless it is there or on its way, and gives the status. The
     * download goes on in the background until it ends or RPGTL exits.
     */
    readonly download: Effect.Effect<ProgramStatus>;
    /** The NW.js program, once it is downloaded. */
    readonly program: Effect.Effect<string, ProgramMissingError>;
  }
>()("@rpgtl/server/nwjs/Nwjs") {}

type Progress =
  | { readonly _tag: "Idle"; readonly error: Option.Option<string> }
  | { readonly _tag: "Downloading"; readonly received: number };

interface Attempt {
  readonly attempt: number;
  readonly now: Progress;
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const release = yield* NwjsRelease;
  const fetchPinnedArchive = yield* makeFetchPinnedArchive;
  const base = path.join(yield* userFolder("cache"), "nwjs");
  const folder = path.join(base, release.version);
  const binary = path.join(folder, release.program);
  // Downloads run in the layer's scope, so RPGTL exiting stops them.
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
      version: release.version,
      size: release.size,
      folder: base,
      phase: isReady
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

  const fetchRelease = fetchPinnedArchive({ ...release, what: "NW.js" }, folder, (bytes) =>
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
          else yield* Effect.logError("The NW.js download stopped.", cause);
          yield* settle({
            _tag: "Idle",
            error: Option.some(error?.message ?? "The NW.js download stopped. Try again."),
          });
        }),
    }),
    Effect.withSpan("Nwjs.fetchRelease"),
  );

  const download = SubscriptionRef.updateEffect(progress, (last) =>
    Effect.gen(function* () {
      if (last.now._tag === "Downloading" || (yield* ready)) return last;
      yield* Effect.forkIn(fetchRelease, scope);
      return { attempt: last.attempt + 1, now: { _tag: "Downloading", received: 0 } } as const;
    }),
  ).pipe(Effect.andThen(status), Effect.withSpan("Nwjs.download"));

  const program = ready.pipe(
    Effect.filterOrFail(
      (found) => found,
      () => new ProgramMissingError(),
    ),
    Effect.as(binary),
    Effect.withSpan("Nwjs.program"),
  );

  return Nwjs.of({ changes, download, program });
});

export const layer = Layer.effect(Nwjs, make);
