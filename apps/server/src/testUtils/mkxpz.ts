import * as NodeServices from "@effect/platform-node/NodeServices";
import { applyXpTranslations, writeArchive } from "@rpgtl/domain";
import { rubyObject, xpFile, xpScripts } from "@rpgtl/domain/testUtils/xpGame";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Mkxpz from "../mkxpz/Mkxpz.ts";
import { httpClientAnswering } from "./ollama.ts";

/** Whether this computer can show mkxp-z's window on a display of its own. */
export const xvfbRun = spawnSync("sh", ["-c", "command -v xvfb-run"]).status === 0;

/** The mkxp-z in RPGTL's cache folder; none when it was never downloaded. */
export const cachedMkxpz = Effect.flatMap(Mkxpz.Mkxpz, (mkxpz) =>
  mkxpz.program.pipe(
    Effect.asSome,
    Effect.catchTags({ ProgramMissingError: () => Effect.succeedNone }),
  ),
);

export const mkxpzLayer = Mkxpz.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeServices.layer,
      httpClientAnswering(() => Effect.succeedNone),
      // The tests' setup points XDG_CACHE_HOME at an empty folder; mkxp-z is only read.
      ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: homedir() })),
    ),
  ),
);

/**
 * Plays a made-up XP game in mkxp-z and gives the report its `Main` writes. Its archive holds
 * `archived` and its patches folder `patched`, by path below the game's folder. Its translated
 * `Scripts.rxdata` holds RPGTL's scripts twice, as pressing F12 loads every script again. A Ruby
 * error waits in a message box nobody can close, so `main` should catch every error and write it
 * to the report.
 */
export const playXpGame = Effect.fn("playXpGame")(function* (
  program: string,
  game: {
    readonly engine: string;
    readonly main: (report: string) => string;
    readonly archived?: Readonly<Record<string, Uint8Array>>;
    readonly patched?: Readonly<Record<string, Uint8Array>>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const dir = yield* fs.makeTempDirectoryScoped();
  const report = path.join(dir, "report.json");
  const scripts = xpFile(xpScripts({ Engine: game.engine, Main: game.main(report) }));
  const once = Result.getOrThrow(applyXpTranslations("Scripts.rxdata", scripts, []));
  const twice = Result.getOrThrow(applyXpTranslations("Scripts.rxdata", once ?? scripts, []));
  const patched = { "Data/Scripts.rxdata": twice ?? scripts, ...game.patched };
  for (const [file, bytes] of Object.entries(patched)) {
    yield* fs.makeDirectory(path.dirname(path.join(dir, "run/patches", file)), { recursive: true });
    yield* fs.writeFile(path.join(dir, "run/patches", file), bytes);
  }
  yield* fs.makeDirectory(path.join(dir, "game"));
  yield* fs.writeFile(
    path.join(dir, "game/Game.rgssad"),
    writeArchive(
      new Map([
        ["Data/System.rxdata", xpFile(rubyObject("RPG::System", {}))],
        ...Object.entries(game.archived ?? {}),
      ]),
    ),
  );
  yield* fs.writeFileString(
    path.join(dir, "game/Game.ini"),
    "[Game]\r\nLibrary=RGSS102E.dll\r\nScripts=Data\\Scripts.rxdata\r\nTitle=Fixture\r\n",
  );
  yield* fs.writeFileString(
    path.join(dir, "run/mkxp.json"),
    JSON.stringify(
      Mkxpz.mkxpConfig(
        path.dirname(program),
        path.join(dir, "game"),
        path.join(dir, "run/patches"),
      ),
    ),
  );
  const output = yield* spawner
    .string(
      ChildProcess.make("xvfb-run", ["-d", program], {
        env: { SRCDIR: path.join(dir, "run") },
        extendEnv: true,
        stdin: "ignore",
      }),
      { includeStderr: true },
    )
    .pipe(Effect.timeout(Duration.seconds(60)));
  return yield* fs.readFileString(report).pipe(
    Effect.catchTags({
      PlatformError: () => Effect.die(`mkxp-z wrote no report:\n${output.slice(-2000)}`),
    }),
  );
});
