import { createHash } from "node:crypto";
import {
  type Entry,
  type Game,
  gameFiles,
  type GameLaunch,
  type ProgramStatus,
} from "@rpgtl/contracts";
import { hookScript, type HookConfig } from "@rpgtl/game/scripts";
import { applyXpTranslations, entryTranslation, translatedByXpFile } from "@rpgtl/domain";
import * as Result from "effect/Result";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Frontend from "../frontend/Frontend.ts";
import * as Games from "../games/Games.ts";
import { displayFlags } from "../play/displayFlags.ts";
import * as Settings from "../settings/Settings.ts";
import * as StateFolder from "../state/StateFolder.ts";
import { userFolder } from "../state/userFolders.ts";
import { OnWindows } from "../OnWindows.ts";
import { runningCommit } from "../runningCommit.ts";
import * as Nwjs from "./Nwjs.ts";
import * as Mkxpz from "../mkxpz/Mkxpz.ts";
import { mkxpConfig } from "../mkxpz/Mkxpz.ts";
import * as Catalogs from "../games/Catalogs.ts";
import * as GameFolder from "../games/GameFolder.ts";
import type { ProgramMissingError } from "../downloads/pinnedProgram.ts";

/** The files the game's program needs couldn't be made, or the program didn't start. */
export class LaunchError extends Schema.TaggedError<LaunchError>()("LaunchError", {
  id: Schema.String,
  operation: Schema.Literals(["prepare", "start", "stop"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    switch (this.operation) {
      case "prepare":
        return `Couldn't make the files game ${this.id} starts with.`;
      case "start":
        return `Couldn't start game ${this.id}.`;
      case "stop":
        return `Couldn't stop game ${this.id}.`;
    }
  }
}

/** The game's last start still runs; starting it again would rebuild the folder it runs from. */
export class GameRunningError extends Schema.TaggedError<GameRunningError>()("GameRunningError", {
  id: Schema.String,
}) {
  override get message() {
    return `Game ${this.id} is already running.`;
  }
}

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const isJsonObject = Schema.is(JsonObject);
const PackageJson = Schema.fromJsonString(JsonObject);
const SystemSize = Schema.fromJsonString(
  Schema.Struct({
    advanced: Schema.optionalKey(
      Schema.Struct({
        screenWidth: Schema.optionalKey(Schema.Finite),
        screenHeight: Schema.optionalKey(Schema.Finite),
      }),
    ),
  }),
);

/** `words` as one line to paste into a terminal: PowerShell's on Windows, sh's elsewhere. */
export const commandLine = (words: ReadonlyArray<string>, windows: boolean) =>
  windows
    ? `& ${words.map((word) => `'${word.replaceAll("'", "''")}'`).join(" ")}`
    : words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");

/**
 * How to start mkxp-z, which reads `mkxp.json` in the folder `SRCDIR` names. A shell sends its
 * output to `log`.
 */
const mkxpzCommand = (program: string, dir: string, log: string) => ({
  words: ["env", `SRCDIR=${dir}`, program],
  command: ChildProcess.make("sh", ["-c", 'exec "$0" >"$1" 2>&1', program, log], {
    env: { SRCDIR: dir },
    extendEnv: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }),
});

/**
 * Games started with Play: MV and MZ games in NW.js, which reads each game's catalog from disk
 * itself, and XP games in mkxp-z, which reads the translated data files written before it starts.
 */
export class Launches extends Context.Service<
  Launches,
  {
    /**
     * Writes what the game's program needs in `<state>/games/<id>/` (NW.js's app folder, or
     * mkxp-z's translated data files) and starts the program, holding the game meanwhile, unless
     * the game's last start still runs. The program keeps running after RPGTL exits.
     */
    readonly launch: (
      id: string,
    ) => Effect.Effect<
      GameLaunch,
      | Games.GameNotInspectedError
      | Games.GameBusyError
      | Games.EngineUnsupportedError
      | ProgramMissingError
      | GameRunningError
      | LaunchError
      | Frontend.FrontendFileError
      | StateFolder.StateFileError
    >;
    /**
     * Starts downloading the program the game is started in, unless it is there or on its way,
     * and gives its status.
     */
    readonly download: (id: string) => Effect.Effect<ProgramStatus, Games.GameNotInspectedError>;
    /** Ends the game's program and what it started, if the game's last start still runs. */
    readonly stop: (id: string) => Effect.Effect<void, Games.GameNotInspectedError | LaunchError>;
    /** The game's last start now and after each change, until the stream is closed. */
    readonly changes: (
      id: string,
    ) => Effect.Effect<Stream.Stream<Option.Option<GameLaunch>>, Games.GameNotInspectedError>;
  }
>()("@rpgtl/server/nwjs/Launches") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const state = yield* StateFolder.StateFolder;
  // Without a profile folder, NW.js makes two folders per game, in ~/.config and ~/.cache, named
  // after the manifest. Outside ~/.config, it keeps the cache inside the profile folder.
  const profiles = path.join(yield* userFolder("state"), "nwjs");
  const games = yield* Games.Games;
  const settings = yield* Settings.Settings;
  const frontend = yield* Frontend.Frontend;
  const nwjs = yield* Nwjs.Nwjs;
  const mkxpz = yield* Mkxpz.Mkxpz;
  const catalogs = yield* Catalogs.Catalogs;
  const gameFolder = yield* GameFolder.GameFolder;
  // Each start waits for NW.js's exit in a fiber of the layer's scope, which RPGTL exiting ends
  // without stopping NW.js.
  const scope = yield* Effect.scope;
  const launches = yield* SubscriptionRef.make(
    new Map<
      string,
      {
        readonly launch: GameLaunch;
        readonly stop: Effect.Effect<void, PlatformError.PlatformError>;
      }
    >(),
  );

  /** The JSON file decoded; none when it is missing or doesn't decode, as NW.js then has none. */
  const jsonFile = <A>(
    file: string,
    schema: Schema.Decoder<A>,
  ): Effect.Effect<Option.Option<A>, PlatformError.PlatformError> =>
    fs.readFileString(file).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(error),
        SchemaError: () => Effect.succeedNone,
      }),
    );

  /** The `package.json` NW.js opens the game with; the game's own one wins where it has one. */
  const manifest = Effect.fnUntraced(function* (game: Game, appDir: string, hookFile: string) {
    const dirs = game.webRoot === game.root ? [game.root] : [game.webRoot, game.root];
    const found = yield* Effect.forEach(dirs, (dir) =>
      Effect.map(
        jsonFile(path.join(dir, "package.json"), PackageJson),
        Option.map((json) => ({ dir, json })),
      ),
    );
    const own = found.flatMap((option) => (Option.isSome(option) ? [option.value] : []));
    const pick = (key: string) => own.find(({ json }) => json[key] !== undefined);
    const window = pick("window");
    const system = yield* jsonFile(path.join(game.webRoot, "data", "System.json"), SystemSize);
    const size = Option.getOrUndefined(system)?.advanced;
    const jsFlags = pick("js-flags")?.json["js-flags"];
    const chromiumArgs = pick("chromium-args")?.json["chromium-args"];
    return {
      name: `rpgtl-${game.id}`,
      main: (yield* path.toFileUrl(path.join(game.webRoot, "index.html"))).href,
      inject_js_start: hookFile,
      // The game's page loads its files from its own folder, outside the app folder.
      "node-remote": ["file://*"],
      "chromium-args": [chromiumArgs, "--allow-file-access-from-files"]
        .filter((arg) => typeof arg === "string" && arg !== "")
        .join(" "),
      ...(jsFlags !== undefined && { "js-flags": jsFlags }),
      window: window
        ? yield* windowWithIcon(appDir, window.dir, window.json.window)
        : {
            title: game.title,
            width: size?.screenWidth ?? 816,
            height: size?.screenHeight ?? 624,
            position: "center",
          },
    };
  });

  /** NW.js only loads an icon inside the app folder, so the game's icon is copied there. */
  const windowWithIcon = Effect.fnUntraced(function* (
    appDir: string,
    dir: string,
    window: unknown,
  ) {
    if (!isJsonObject(window)) return window;
    const { icon, ...rest } = window;
    if (typeof icon !== "string") return window;
    const source = path.resolve(dir, icon);
    if (!(yield* fs.exists(source))) return rest;
    const copy = `icon${path.extname(source)}`;
    yield* fs.copyFile(source, path.join(appDir, copy));
    return { ...rest, icon: copy };
  });

  const hook = Effect.fnUntraced(function* (game: Game, log: string) {
    const config: HookConfig = {
      catalog: path.join(state.root, gameFiles(game.id).catalog),
      data: path.join(game.webRoot, "data"),
      erased: path.join(state.root, gameFiles(game.id).erasedImages),
      images: path.join(state.root, gameFiles(game.id).imageResults),
      log,
      playtime: path.join(state.root, gameFiles(game.id).playtime),
      root: game.root,
    };
    const built = yield* Effect.all({
      "nwjs-hook.js": frontend.script("nwjs-hook.js"),
      "runtime.js": frontend.script("runtime.js"),
      "map-view.js": frontend.script("map-view.js"),
    });
    return `${displayFlags(yield* settings.get)}\n${hookScript(config, built)}`;
  });

  /** The folder NW.js opens: a `package.json` that opens the game's index.html, and its icon. */
  const appFolder = Effect.fnUntraced(function* (game: Game, hookText: string) {
    const files = gameFiles(game.id);
    const appDir = path.join(state.root, files.nwjsApp);
    const hookFile = path.join(state.root, files.nwjsHook);
    yield* fs.remove(appDir, { recursive: true, force: true });
    yield* fs.makeDirectory(appDir, { recursive: true });
    yield* fs.writeFileString(hookFile, hookText);
    const json = yield* manifest(game, appDir, hookFile);
    yield* fs.writeFileString(path.join(appDir, "package.json"), JSON.stringify(json, null, 2));
    return appDir;
  });

  // A checkout with changes has no commit that names the code that wrote the patched files, so
  // only this process's own launches reuse them.
  const writer = Option.getOrElse(
    Option.filter(yield* runningCommit, (commit) => !commit.endsWith("-dirty")),
    () => SecureRandom.uuidV4Unsafe(),
  );
  const decodeWritten = Schema.decodeEffect(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
  );
  /** What a patched data file is made from: the game's file, its English and RPGTL's code. */
  const fingerprint = (name: string, bytes: Uint8Array, entries: ReadonlyArray<Entry>) => {
    const hash = createHash("sha256").update(writer).update(name).update(bytes);
    for (const entry of entries) hash.update(JSON.stringify([entry.id, entryTranslation(entry)]));
    return hash.digest("hex");
  };

  /**
   * The folder mkxp-z starts in: its `mkxp.json`, and the data files that hold translated text
   * while the game's translation switch is on, which it reads before the game's own. A data file
   * whose game file, English and RPGTL are those of the last launch stays as it is.
   */
  const mkxpzFolder = Effect.fnUntraced(function* (game: Game, program: string) {
    const dir = path.join(state.root, gameFiles(game.id).mkxpz);
    const patches = path.join(dir, "patches");
    const data = path.join(patches, "Data");
    const writtenFile = path.join(dir, "patches.json");
    yield* fs.makeDirectory(data, { recursive: true });
    // A missing or unreadable list only means every file is written again.
    const written: Readonly<Record<string, string>> = yield* fs.readFileString(writtenFile).pipe(
      Effect.flatMap(decodeWritten),
      Effect.catchTags({
        PlatformError: () => Effect.succeed({}),
        SchemaError: () => Effect.succeed({}),
      }),
    );
    // A launch that fails partway may leave files the old list doesn't describe.
    yield* fs.remove(writtenFile, { force: true });
    const catalog = yield* catalogs.get(game.id);
    const translated = catalog.translate ? translatedByXpFile(catalog) : new Map();
    const files = yield* gameFolder.xpData(game);
    const prints: Record<string, string> = {};
    for (const [name, bytes] of files) {
      const entries = translated.get(name) ?? [];
      const print = fingerprint(name, bytes, entries);
      const file = path.join(data, name);
      if (written[name] === print && (!entries.length || (yield* fs.exists(file)))) {
        prints[name] = print;
        continue;
      }
      yield* fs.remove(file, { force: true });
      const patched = applyXpTranslations(name, bytes, entries);
      if (Result.isFailure(patched)) {
        yield* Effect.logWarning(`${name} plays untranslated.`, patched.failure);
        continue;
      }
      if (patched.success) yield* fs.writeFile(file, patched.success);
      prints[name] = print;
    }
    for (const name of Object.keys(written))
      if (!files.has(name)) yield* fs.remove(path.join(data, name), { force: true });
    yield* fs.writeFileString(writtenFile, JSON.stringify(prints));
    const config = mkxpConfig(path.dirname(program), game.root, patches);
    yield* fs.writeFileString(path.join(dir, "mkxp.json"), JSON.stringify(config, null, 2));
    return dir;
  });

  /** How to start NW.js, which writes its own warnings and errors to `log`. */
  const nwjsCommand = (id: string, program: string, appDir: string, log: string) => {
    const args = [
      "--enable-logging",
      `--log-file=${log}`,
      "--log-level=1",
      `--user-data-dir=${path.join(profiles, id)}`,
      appDir,
    ];
    return {
      words: [program, ...args],
      command: ChildProcess.make(program, args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        // On Windows a child process starts hidden by default, and NW.js's window then never
        // draws.
        windowsHide: false,
      }),
    };
  };

  /**
   * Starts the game's program, which writes its output to a file of its own, as RPGTL's pipes
   * would close when it exits while the game goes on.
   */
  const start = Effect.fnUntraced(function* (
    id: string,
    log: string,
    {
      words,
      command,
    }: { readonly words: ReadonlyArray<string>; readonly command: ChildProcess.Command },
  ) {
    const result = yield* Deferred.make<GameLaunch, LaunchError>();
    const running = Effect.gen(function* () {
      const handle = yield* spawner.spawn(command);
      // An unreferenced process outlives the scope that started it.
      yield* Effect.asVoid(handle.unref);
      const launch: GameLaunch = {
        phase: { _tag: "Running" },
        pid: handle.pid,
        log,
        command: commandLine(words, yield* OnWindows),
      };
      // NW.js ends with exit code 0 on a signal once its page has loaded.
      const stopAsked = yield* Ref.make(false);
      const started = { launch, stop: Effect.andThen(Ref.set(stopAsked, true), handle.kill()) };
      yield* SubscriptionRef.update(launches, (all) => new Map(all).set(id, started));
      yield* Deferred.succeed(result, launch);
      // A process ended by a signal has no exit code, which Effect gives as a failure.
      const exitCode = yield* handle.exitCode.pipe(
        Effect.asSome,
        Effect.catchTags({ PlatformError: () => Effect.succeedNone }),
      );
      const last = {
        ...started,
        launch: {
          ...launch,
          phase:
            (yield* Ref.get(stopAsked)) || Option.isNone(exitCode)
              ? { _tag: "Stopped" as const }
              : { _tag: "Exited" as const, exitCode: exitCode.value },
        },
      };
      // A later start of the same game keeps its own status.
      yield* SubscriptionRef.update(launches, (all) =>
        all.get(id) === started ? new Map(all).set(id, last) : all,
      );
    }).pipe(
      Effect.scoped,
      Effect.catchTags({
        PlatformError: (cause) => Effect.fail(new LaunchError({ id, operation: "start", cause })),
      }),
      // Completes the start with any failure before it, a defect too; after it this does nothing.
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? Deferred.failCause(result, exit.cause) : Effect.void,
      ),
    );
    yield* Effect.forkIn(running, scope);
    return yield* Deferred.await(result);
  });

  const launch = Effect.fn("Launches.launch")(function* (id: string) {
    const game = yield* games.get(id);
    yield* Games.requireFeature(game, "play");
    const xp = game.engine === "XP";
    const program = yield* (xp ? mkxpz : nwjs).program;
    return yield* games.exclusive(
      id,
      Effect.gen(function* () {
        if ((yield* SubscriptionRef.get(launches)).get(id)?.launch.phase._tag === "Running")
          return yield* new GameRunningError({ id });
        const log = path.join(state.root, gameFiles(id).logs, xp ? "mkxpz.log" : "nwjs.log");
        const hookText = xp ? "" : yield* hook(game, log);
        const prepared = Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(log), { recursive: true });
          yield* fs.writeFileString(log, "");
          return xp
            ? mkxpzCommand(program, yield* mkxpzFolder(game, program), log)
            : nwjsCommand(id, program, yield* appFolder(game, hookText), log);
        }).pipe(
          Effect.catchTags({
            PlatformError: (cause) =>
              Effect.fail(new LaunchError({ id, operation: "prepare", cause })),
            BadArgument: (cause) =>
              Effect.fail(new LaunchError({ id, operation: "prepare", cause })),
            GameFileReadError: (cause) =>
              Effect.fail(new LaunchError({ id, operation: "prepare", cause })),
            GameFileInvalid: (cause) =>
              Effect.fail(new LaunchError({ id, operation: "prepare", cause })),
          }),
        );
        return yield* start(id, log, yield* prepared);
      }),
    );
  });

  const changes = Effect.fn("Launches.changes")(function* (id: string) {
    yield* games.get(id);
    return SubscriptionRef.changes(launches).pipe(
      Stream.map((all) => all.get(id)?.launch),
      Stream.changesWith((a, b) => a === b),
      Stream.map(Option.fromUndefinedOr),
    );
  });

  const stop = Effect.fn("Launches.stop")(function* (id: string) {
    yield* games.get(id);
    const last = (yield* SubscriptionRef.get(launches)).get(id);
    if (last?.launch.phase._tag !== "Running") return;
    yield* last.stop.pipe(
      Effect.catchTags({
        PlatformError: (cause) => Effect.fail(new LaunchError({ id, operation: "stop", cause })),
      }),
    );
  });

  const download = Effect.fn("Launches.download")(function* (id: string) {
    const game = yield* games.get(id);
    return yield* (game.engine === "XP" ? mkxpz : nwjs).download;
  });

  return Launches.of({ launch, download, stop, changes });
});

export const layer = Layer.effect(Launches, make);
