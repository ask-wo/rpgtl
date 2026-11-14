import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** The commit the portable download was built from, which its bundler writes in. */
declare const RPGTL_BUILT_COMMIT: string | undefined;

/**
 * The commit of the code RPGTL runs, with `-dirty` when its checkout has changes; the portable
 * download carries the one it was built from, and another copy without git has none. Read it when
 * RPGTL starts, since that is the code it runs.
 */
export const runningCommit = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const git = (...args: ReadonlyArray<string>) =>
    spawner.string(ChildProcess.make("git", ["-C", import.meta.dirname, ...args]));
  return yield* typeof RPGTL_BUILT_COMMIT === "string"
    ? Effect.succeedSome(RPGTL_BUILT_COMMIT)
    : Effect.all([
        git("rev-parse", "--short", "HEAD"),
        git("status", "--porcelain", "--untracked-files=no"),
      ]).pipe(
        Effect.map(([head, changes]) => `${head.trim()}${changes.trim() ? "-dirty" : ""}`),
        Effect.asSome,
        Effect.catchTags({ PlatformError: () => Effect.succeedNone }),
      );
});

/**
 * A name for the code RPGTL runs, to tell whether a file it made earlier is still what this code
 * would make: its commit, or else one that only this process uses, since a checkout with changes
 * or a copy without git has no commit that names its code.
 */
export const codeVersion = Effect.map(runningCommit, (commit) =>
  Option.getOrElse(
    Option.filter(commit, (each) => !each.endsWith("-dirty")),
    () => SecureRandom.uuidV4Unsafe(),
  ),
);
