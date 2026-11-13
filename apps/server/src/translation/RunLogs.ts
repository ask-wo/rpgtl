import {
  type RunLogLine,
  RunLogLine as RunLogLineSchema,
  type RunStartLine,
  fileTime,
  gameFiles,
} from "@rpgtl/contracts";
import { type RunLog, runLog } from "@rpgtl/domain";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { runningCommit } from "../runningCommit.ts";
import * as StateFolder from "../state/StateFolder.ts";

type Later = Exclude<RunLogLine, RunStartLine>;
/** A start line's fields that the run gives; the log adds the commit. */
type StartFields = RunStartLine extends infer Line
  ? Line extends RunStartLine
    ? Omit<Line, "type" | "commit">
    : never
  : never;
/** A line after the first, without the time, which the log adds. */
type LaterLine = Later extends infer Line ? (Line extends Later ? Omit<Line, "at"> : never) : never;

/** A run's log that can't be read, or holds a line that isn't a run log line. */
export class RunLogReadError extends Schema.TaggedError<RunLogReadError>()("RunLogReadError", {
  file: Schema.String,
  /** The line that doesn't decode, counted from 1; none when the file can't be read. */
  line: Schema.optionalKey(Schema.Int),
  cause: Schema.Defect(),
}) {
  override get message() {
    return this.line === undefined
      ? `Couldn't read the run log ${this.file}.`
      : `Line ${this.line} of ${this.file} isn't a run log line.`;
  }
}

/** The log of one run as it is written; its lines go out in the order they are written. */
export interface RunLogWriter {
  readonly write: (line: LaterLine) => Effect.Effect<void, StateFolder.StateFileError>;
}

/**
 * Each translation run's log, `games/<game id>/logs/translation-<start time>.log` in the state folder:
 * one JSON line for what the run used, then one for each request, question and warning, and one
 * when it ends. The audit and the comparison read them.
 */
export class RunLogs extends Context.Service<
  RunLogs,
  {
    /** Starts the log of the game's run that started at `started`. */
    readonly open: (
      id: string,
      start: StartFields,
    ) => Effect.Effect<RunLogWriter, StateFolder.StateFileError>;
    /** The game's run logs, newest first, as paths. */
    readonly list: (id: string) => Effect.Effect<ReadonlyArray<string>, StateFolder.StateFileError>;
    /** The run log at `file`, a path, which may be outside the state folder. */
    readonly read: (file: string) => Effect.Effect<RunLog, RunLogReadError>;
  }
>()("@rpgtl/server/translation/RunLogs") {}

const make = Effect.gen(function* () {
  const folder = yield* StateFolder.StateFolder;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commit = yield* runningCommit;

  const open = Effect.fn("RunLogs.open")(function* (id: string, start: StartFields) {
    const file = `${gameFiles(id).logs}/translation-${fileTime(start.started)}.log`;
    const writes = yield* Semaphore.make(1);
    const append = (line: RunLogLine) =>
      writes.withPermits(1)(folder.appendLine(file, RunLogLineSchema, line));
    yield* append({
      type: "run",
      ...start,
      ...(commit._tag === "Some" && { commit: commit.value }),
    });
    const write = Effect.fn("RunLog.write")(function* (line: LaterLine) {
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* append({ ...line, at });
    });
    return { write } satisfies RunLogWriter;
  });

  const list = Effect.fn("RunLogs.list")(function* (id: string) {
    const logs = gameFiles(id).logs;
    return (yield* folder.list(logs))
      .filter((name) => name.startsWith("translation-") && name.endsWith(".log"))
      .toSorted()
      .toReversed()
      .map((name) => path.join(folder.root, logs, name));
  });

  const decodeLine = Schema.decodeEffect(Schema.fromJsonString(RunLogLineSchema));
  const read = Effect.fn("RunLogs.read")(function* (file: string) {
    const resolved = path.resolve(file);
    const text = yield* fs
      .readFileString(resolved)
      .pipe(Effect.mapError((cause) => new RunLogReadError({ file: resolved, cause })));
    const lines = yield* Effect.forEach(text.split("\n").entries(), ([index, line]) =>
      line.trim()
        ? decodeLine(line).pipe(
            Effect.map((decoded) => [decoded]),
            Effect.mapError(
              (cause) => new RunLogReadError({ file: resolved, line: index + 1, cause }),
            ),
          )
        : Effect.succeed([]),
    );
    return runLog(resolved, lines.flat());
  });

  return RunLogs.of({ open, list, read });
});

export const layer = Layer.effect(RunLogs, make);
