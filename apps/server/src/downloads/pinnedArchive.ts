import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

export class ArchiveDownloadError extends Schema.TaggedError<ArchiveDownloadError>()(
  "ArchiveDownloadError",
  {
    /** What was downloaded, such as `NW.js`. */
    what: Schema.String,
    problem: Schema.Literals(["unreachable", "checksum", "unpack", "save"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    const messages: Record<typeof this.problem, string> = {
      unreachable: `Couldn't download ${this.what}. Check the internet connection and try again.`,
      checksum: `The ${this.what} download didn't match its expected checksum and was deleted. Try again.`,
      unpack: `Unpacking ${this.what} failed. Try again.`,
      save: `Couldn't save ${this.what} in RPGTL's cache folder. RPGTL's log says why.`,
    };
    return messages[this.problem];
  }
}

/** A release archive RPGTL downloads, pinned to its size and checksum. */
export interface PinnedArchive {
  /** What it is, for messages, such as `NW.js`. */
  readonly what: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
  /** The folder in the archive that becomes `target`, or `""` when its files sit at the top. */
  readonly folder: string;
  /** Whether it is an AppImage, which unpacks itself into `squashfs-root`, not a tar or zip. */
  readonly appImage?: boolean;
}

/**
 * A function that downloads `archive`, checks it, and unpacks it into `target`, which it replaces
 * at once, so an interrupted download never leaves half a folder. `received` hears of each
 * chunk's bytes.
 */
export const makeFetchPinnedArchive = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects());

  return Effect.fn("fetchPinnedArchive")(function* (
    archive: PinnedArchive,
    target: string,
    received: (bytes: number) => Effect.Effect<void>,
  ) {
    const failure = (problem: ArchiveDownloadError["problem"]) => (cause?: unknown) =>
      new ArchiveDownloadError({
        what: archive.what,
        problem,
        ...(cause !== undefined && { cause }),
      });
    const base = path.dirname(target);
    const download = `${target}.download.part`;
    // `force` makes a missing file no failure, so what's left is one worth logging.
    const removeLeftover = (file: string) =>
      fs.remove(file, { recursive: true, force: true }).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            Effect.logWarning(`Couldn't remove what a ${archive.what} download left.`, error),
        }),
      );

    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(base, { recursive: true }).pipe(Effect.mapError(failure("save")));
      const response = yield* client
        .get(archive.url)
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError(failure("unreachable")),
        );
      const hash = createHash("sha256");
      let total = 0;
      yield* response.stream.pipe(
        Stream.mapError(failure("unreachable")),
        Stream.tap((chunk) =>
          Effect.andThen(
            Effect.sync(() => {
              hash.update(chunk);
              total += chunk.length;
            }),
            received(chunk.length),
          ),
        ),
        Stream.run(fs.sink(download).pipe(Sink.mapError(failure("save")))),
      );
      if (total !== archive.size || hash.digest("hex") !== archive.sha256)
        return yield* failure("checksum")();
      const unpacked = yield* fs
        .makeTempDirectory({ directory: base, prefix: "unpack-" })
        .pipe(Effect.mapError(failure("save")));
      yield* Effect.gen(function* () {
        const code = yield* (
          archive.appImage
            ? Effect.andThen(
                fs.chmod(download, 0o755),
                spawner.exitCode(
                  ChildProcess.make(download, ["--appimage-extract"], {
                    cwd: unpacked,
                    stdout: "ignore",
                    stderr: "ignore",
                  }),
                ),
              )
            : // Windows' tar unpacks zip files too.
              spawner.exitCode(ChildProcess.make("tar", ["-xf", download, "-C", unpacked]))
        ).pipe(Effect.mapError(failure("unpack")));
        if (code !== 0) return yield* failure("unpack")();
        yield* Effect.uninterruptible(
          Effect.andThen(
            fs.remove(target, { recursive: true, force: true }),
            fs.rename(path.join(unpacked, archive.folder), target),
          ),
        ).pipe(Effect.mapError(failure("save")));
      }).pipe(Effect.ensuring(removeLeftover(unpacked)));
    }).pipe(Effect.ensuring(removeLeftover(download)));
  });
});
