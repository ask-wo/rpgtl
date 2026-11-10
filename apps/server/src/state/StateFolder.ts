import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { stateUpgrades } from "./stateUpgrades.ts";
import { upgrade } from "./upgrade.ts";

/** A file in the state folder that can't be read, decoded or written. */
export class StateFileError extends Schema.TaggedError<StateFileError>()("StateFileError", {
  file: Schema.String,
  operation: Schema.Literals(["read", "write"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Couldn't ${this.operation} ${this.file}.`;
  }
}

/** RPGTL's state folder (`RPGTL_DIR`): the game list and a folder of files for each game. */
export class StateFolder extends Context.Service<
  StateFolder,
  {
    readonly root: string;
    /** The file decoded with `schema`, or none when there is no such file. */
    readonly read: <A, I>(
      file: string,
      schema: Schema.Codec<A, I>,
    ) => Effect.Effect<Option.Option<A>, StateFileError>;
    readonly readBytes: (file: string) => Effect.Effect<Uint8Array, StateFileError>;
    /** Writes to a temporary file first, so a crash never leaves half a file behind. */
    readonly write: <A, I>(
      file: string,
      schema: Schema.Codec<A, I>,
      value: A,
    ) => Effect.Effect<void, StateFileError>;
    /** Writes the bytes as `write` writes a value. */
    readonly writeBytes: (file: string, bytes: Uint8Array) => Effect.Effect<void, StateFileError>;
    /** Adds the value as a line of JSON to the end of the file, making the file if needed. */
    readonly appendLine: <A, I>(
      file: string,
      schema: Schema.Codec<A, I>,
      value: A,
    ) => Effect.Effect<void, StateFileError>;
    /** The names in `folder`; none when there is no such folder. */
    readonly list: (folder: string) => Effect.Effect<ReadonlyArray<string>, StateFileError>;
    /** Removes the file, or the folder with everything in it; nothing when it isn't there. */
    readonly remove: (file: string) => Effect.Effect<void, StateFileError>;
    /** Copies the file to `backups/` in its folder, if it exists, under its name and the time. */
    readonly backUp: (file: string) => Effect.Effect<void, StateFileError>;
    /** Copies the file or folder to `to`, making the folders above it; nothing when it isn't there. */
    readonly copy: (file: string, to: string) => Effect.Effect<void, StateFileError>;
    /** Moves the file or folder to `to`, making the folders above it; nothing when it isn't there. */
    readonly move: (file: string, to: string) => Effect.Effect<void, StateFileError>;
  }
>()("@rpgtl/server/state/StateFolder") {}

/** The folder at `dir` with the state folder's ways of reading and writing files. */
export const make = Effect.fn("StateFolder.make")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(dir);
  const failed = (file: string, operation: "read" | "write") => (cause: unknown) =>
    new StateFileError({ file: path.join(root, file), operation, cause });
  const randomName = Random.nextIntBetween(0, 2 ** 48).pipe(
    Effect.map((n) => n.toString(16).padStart(12, "0")),
  );

  const read = Effect.fn("StateFolder.read")(function* <A, I>(
    file: string,
    schema: Schema.Codec<A, I>,
  ) {
    const text = yield* fs.readFileString(path.join(root, file)).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(error),
      }),
      Effect.mapError(failed(file, "read")),
    );
    if (Option.isNone(text)) return Option.none<A>();
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text.value).pipe(
      Effect.asSome,
      Effect.mapError(failed(file, "read")),
    );
  });

  const readBytes = Effect.fn("StateFolder.readBytes")(function* (file: string) {
    return yield* fs.readFile(path.join(root, file)).pipe(Effect.mapError(failed(file, "read")));
  });

  const writeBytes = Effect.fn("StateFolder.writeBytes")(function* (
    file: string,
    bytes: Uint8Array,
  ) {
    const destination = path.join(root, file);
    const temporary = `${destination}.${yield* randomName}.tmp`;
    // Windows refuses to replace a file while another program has it open, which virus scanners
    // and search indexers do for a moment after it changes.
    const replace = fs.rename(temporary, destination).pipe(
      Effect.retry({
        while: (error) => error.reason._tag === "PermissionDenied" || error.reason._tag === "Busy",
        schedule: Schedule.exponential(Duration.millis(20)),
        times: 9,
      }),
      Effect.tapError(() =>
        fs.remove(temporary).pipe(Effect.catchTags({ PlatformError: () => Effect.void })),
      ),
    );
    yield* fs
      .makeDirectory(path.dirname(destination), { recursive: true })
      .pipe(
        Effect.andThen(fs.writeFile(temporary, bytes)),
        Effect.andThen(replace),
        Effect.mapError(failed(file, "write")),
        Effect.uninterruptible,
      );
  });

  const write = Effect.fn("StateFolder.write")(function* <A, I>(
    file: string,
    schema: Schema.Codec<A, I>,
    value: A,
  ) {
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(schema, { space: 2 }))(
      value,
    ).pipe(Effect.mapError(failed(file, "write")));
    yield* writeBytes(file, new TextEncoder().encode(text));
  });

  const appendLine = Effect.fn("StateFolder.appendLine")(function* <A, I>(
    file: string,
    schema: Schema.Codec<A, I>,
    value: A,
  ) {
    const destination = path.join(root, file);
    yield* Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
      Effect.flatMap((text) =>
        fs
          .makeDirectory(path.dirname(destination), { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(destination, `${text}\n`, { flag: "a" }))),
      ),
      Effect.mapError(failed(file, "write")),
    );
  });

  const list = Effect.fn("StateFolder.list")(function* (folder: string) {
    return yield* fs.readDirectory(path.join(root, folder)).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
      }),
      Effect.mapError(failed(folder, "read")),
    );
  });

  const remove = Effect.fn("StateFolder.remove")(function* (file: string) {
    yield* fs
      .remove(path.join(root, file), { force: true, recursive: true })
      .pipe(Effect.mapError(failed(file, "write")));
  });

  const backUp = Effect.fn("StateFolder.backUp")(function* (file: string) {
    const extension = path.extname(file);
    const backups = path.join(path.dirname(file), "backups");
    const backup = path.join(
      backups,
      `${path.basename(file, extension)}-${yield* Clock.currentTimeMillis}-${yield* randomName}${extension}`,
    );
    yield* fs.makeDirectory(path.join(root, backups), { recursive: true }).pipe(
      Effect.andThen(fs.copyFile(path.join(root, file), path.join(root, backup))),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error),
      }),
      Effect.mapError(failed(backup, "write")),
    );
  });

  const intoOrNotThere = (
    file: string,
    to: string,
    put: (from: string, to: string) => Effect.Effect<void, PlatformError.PlatformError>,
  ) =>
    fs.exists(path.join(root, file)).pipe(
      Effect.flatMap((there) =>
        there
          ? fs
              .makeDirectory(path.dirname(path.join(root, to)), { recursive: true })
              .pipe(Effect.andThen(put(path.join(root, file), path.join(root, to))))
          : Effect.void,
      ),
      Effect.mapError(failed(to, "write")),
    );

  const copy = Effect.fn("StateFolder.copy")(function* (file: string, to: string) {
    yield* intoOrNotThere(file, to, fs.copy);
  });

  const move = Effect.fn("StateFolder.move")(function* (file: string, to: string) {
    yield* intoOrNotThere(file, to, fs.rename);
  });

  return StateFolder.of({
    root,
    read,
    readBytes,
    write,
    writeBytes,
    appendLine,
    list,
    remove,
    backUp,
    copy,
    move,
  });
});

/** The state folder at `dir`, relative to the working folder, with its files in the latest format. */
export const layerAt = (dir: string) =>
  Layer.effect(StateFolder, make(dir).pipe(Effect.tap((folder) => upgrade(folder, stateUpgrades))));

/** The state folder `RPGTL_DIR` names, or `.rpgtl/` in the working folder. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const dir = (yield* Config.String("RPGTL_DIR").pipe(Config.withDefault(""))) || ".rpgtl";
    // `pnpm start` reads `.env` with Node's --env-file, which doesn't expand `~` as a shell would.
    const belowHome = /^~(\/.*)?$/.exec(dir);
    return layerAt(belowHome ? (yield* Config.String("HOME")) + (belowHome[1] ?? "") : dir);
  }),
);

export const isStateFileError = Schema.is(StateFileError);
