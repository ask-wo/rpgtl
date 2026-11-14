import { gameFiles } from "@rpgtl/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SessionToken from "../auth/SessionToken.ts";
import * as Catalogs from "../games/Catalogs.ts";
import * as Games from "../games/Games.ts";
import * as Settings from "../settings/Settings.ts";
import { folderWith, mvGame } from "../testUtils/gameFolder.ts";
import { writeArchive, xpImageFolder, xpImageTableFile } from "@rpgtl/domain";
import { command, rubyObject, xpFile, xpMap, xpScripts } from "@rpgtl/domain/testUtils/xpGame";
import { noPrograms, opened, playServices, servicesWith, StateDir } from "../testUtils/state.ts";
import { translatedSign } from "../testUtils/xpImages.ts";
import * as Launches from "./Launches.ts";
import * as Nwjs from "./Nwjs.ts";
import * as Mkxpz from "../mkxpz/Mkxpz.ts";

/** An `nw` that logs what it was given to its log file, as NW.js does, and fails. */
const failingNw = `#!/bin/sh
for arg; do case $arg in --log-file=*) log=\${arg#--log-file=} ;; esac; done
echo "opened $*" >>"$log"
exit 7
`;

/** An `nw` that runs until a `quit` file appears next to it. */
const waitingNw = `#!/bin/sh
while [ ! -e "$(dirname "$0")/quit" ]; do sleep 0.05; done
`;

/** An `nw` that runs until it is signalled, then exits with code 0, as NW.js does once its page has loaded. */
const signalledNw = `#!/bin/sh
trap 'exit 0' TERM
while :; do sleep 0.05; done
`;

/** NW.js already downloaded, as the program at `program`. */
const nwjsAt = (program: string) =>
  Layer.succeed(
    Nwjs.Nwjs,
    Nwjs.Nwjs.of({
      changes: Stream.die("not used"),
      download: Effect.die("not used"),
      program: Effect.succeed(program),
    }),
  );

/** An mkxp-z that prints the folder it starts in and the config it finds there, and exits. */
const printingMkxpz = `#!/bin/sh
echo "started in $SRCDIR"
cat "$SRCDIR/mkxp.json"
exit 3
`;

/** mkxp-z already downloaded, as the program at `program`. */
const mkxpzAt = (program: string) =>
  Layer.succeed(
    Mkxpz.Mkxpz,
    Mkxpz.Mkxpz.of({
      changes: Stream.die("not used"),
      download: Effect.die("not used"),
      program: Effect.succeed(program),
    }),
  );

const servicesWithNwjs = <E, R>(
  nwjs: Layer.Layer<Nwjs.Nwjs, E, R>,
  mkxpz = mkxpzAt("/nowhere/mkxp-z"),
) =>
  playServices.pipe(
    Layer.provideMerge(Layer.mergeAll(nwjs, mkxpz)),
    Layer.provideMerge(Layer.succeed(SessionToken.SessionToken, "test-token")),
    Layer.provideMerge(servicesWith({})),
    Layer.provideMerge(NodeServices.layer),
  );

const withFakeNw = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* folderWith({ nw: failingNw });
    yield* fs.chmod(path.join(dir, "nw"), 0o755);
    return servicesWithNwjs(nwjsAt(path.join(dir, "nw")));
  }),
).pipe(Layer.provide(NodeServices.layer));

const withFakeMkxpz = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* folderWith({ "mkxp-z": printingMkxpz });
    yield* fs.chmod(path.join(dir, "mkxp-z"), 0o755);
    return servicesWithNwjs(nwjsAt("/nowhere/nw"), mkxpzAt(path.join(dir, "mkxp-z")));
  }),
).pipe(Layer.provide(NodeServices.layer));

/** The game's last start once NW.js has ended, as the page hears of it. */
const ended = (id: string) =>
  Launches.Launches.pipe(
    Effect.flatMap((launches) => launches.changes(id)),
    Effect.flatMap((changes) =>
      changes.pipe(
        Stream.filter((status) => Option.isSome(status) && status.value.phase._tag !== "Running"),
        Stream.runHead,
        Effect.map(Option.flatten),
      ),
    ),
  );

const inspected = Effect.fnUntraced(function* (files: Record<string, string>) {
  const catalogs = yield* Catalogs.Catalogs;
  return (yield* opened(catalogs.inspect(yield* folderWith(files)))).game;
});

it.live(
  "starts the game from an app folder that opens its index.html, and tells how NW.js ended",
  () =>
    Effect.gen(function* () {
      const launches = yield* Launches.Launches;
      const settings = yield* Settings.Settings;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const state = yield* StateDir;
      const game = yield* inspected({
        ...mvGame,
        "package.json": JSON.stringify({ window: { title: "Root" }, "chromium-args": "--root" }),
        "www/icon.png": "icon",
        "www/package.json": JSON.stringify({
          window: { title: "Web", width: 800, icon: "icon.png" },
          "js-flags": "--web",
        }),
      });
      yield* settings.save({ ...(yield* settings.get), sharpPixels: true });

      yield* launches.launch(game.id);
      yield* ended(game.id);
      const started = yield* launches.launch(game.id);
      const appDir = path.join(state, gameFiles(game.id).nwjsApp);
      const log = path.join(state, gameFiles(game.id).logs, "nwjs.log");
      assert.deepStrictEqual([started.phase, started.log], [{ _tag: "Running" }, log]);
      const args = [
        "--enable-logging",
        `--log-file=${log}`,
        "--log-level=1",
        `--user-data-dir=${path.join(state, ".local", "state", "rpgtl", "nwjs", game.id)}`,
        appDir,
      ];
      assert.match(started.command, new RegExp(`/nw' ${args.map((arg) => `'${arg}'`).join(" ")}$`));
      assert.deepStrictEqual(
        yield* ended(game.id),
        Option.some({ ...started, phase: { _tag: "Exited", exitCode: 7 } }),
      );
      assert.strictEqual(yield* fs.readFileString(log), `opened ${args.join(" ")}\n`);

      assert.deepStrictEqual((yield* fs.readDirectory(appDir)).toSorted(), [
        "icon.png",
        "package.json",
      ]);
      assert.strictEqual(
        yield* fs.readFileString(path.join(appDir, "icon.png")),
        yield* fs.readFileString(path.join(game.webRoot, "icon.png")),
      );
      const hookFile = path.join(state, gameFiles(game.id).nwjsHook);
      assert.deepStrictEqual(
        JSON.parse(yield* fs.readFileString(path.join(appDir, "package.json"))),
        {
          name: `rpgtl-${game.id}`,
          main: `file://${game.webRoot}/index.html`,
          inject_js_start: hookFile,
          "node-remote": ["file://*"],
          "chromium-args": "--root --allow-file-access-from-files",
          "js-flags": "--web",
          window: { title: "Web", width: 800, icon: "icon.png" },
        },
      );
      const hook = yield* fs.readFileString(hookFile);
      assert.isTrue(
        hook.startsWith("window.rpgtlSharpPixels = true; window.rpgtlSharpText = false;\n"),
      );
      assert.include(
        hook,
        `const rpgtl = ${JSON.stringify({
          catalog: path.join(state, gameFiles(game.id).catalog),
          data: path.join(game.webRoot, "data"),
          erased: path.join(state, gameFiles(game.id).erasedImages),
          images: path.join(state, gameFiles(game.id).imageResults),
          log,
          playtime: path.join(state, gameFiles(game.id).playtime),
          root: game.root,
        })};`,
      );
    }).pipe(Effect.provide(withFakeNw)),
  { timeout: 60_000 },
);

it.live(
  "an XP game's translated images go into mkxp-z's patches as tiles while its translation is on",
  () =>
    Effect.gen(function* () {
      const launches = yield* Launches.Launches;
      const catalogs = yield* Catalogs.Catalogs;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const state = yield* StateDir;
      const game = yield* translatedSign("Exit");
      const patches = path.join(state, gameFiles(game.id).mkxpz, "patches");
      const lettered = path.join(patches, xpImageFolder);

      yield* launches.launch(game.id);
      yield* ended(game.id);
      const files = yield* fs.readDirectory(lettered);
      assert.lengthOf(files, 2);
      assert.include(files, path.basename(xpImageTableFile));
      const table = yield* fs.readFile(path.join(patches, xpImageTableFile));
      assert.include(new TextDecoder().decode(table), "graphics/pictures/sign");

      const catalog = yield* catalogs.get(game.id);
      yield* catalogs.save({ ...catalog, translate: false });
      yield* launches.launch(game.id);
      yield* ended(game.id);
      assert.isFalse(yield* fs.exists(lettered));
    }).pipe(Effect.provide(withFakeMkxpz)),
  { timeout: 60_000 },
);

it.live(
  "starts an XP game in mkxp-z with a config that reads the translated data files first",
  () =>
    Effect.gen(function* () {
      const launches = yield* Launches.Launches;
      const catalogs = yield* Catalogs.Catalogs;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const state = yield* StateDir;
      const dir = yield* folderWith({
        "Data/System.rxdata": xpFile(rubyObject("RPG::System", {})),
        "Data/Map001.rxdata": xpFile(xpMap({ 1: [command(101, "你好")] })),
        "Data/Items.rxdata": xpFile([null, rubyObject("RPG::Item", { name: "苔藓" })]),
        "Data/Scripts.rxdata": xpFile(xpScripts({ Main: "begin_game" })),
      });
      const { game, catalog } = yield* opened(catalogs.inspect(dir));
      yield* catalogs.save({
        ...catalog,
        translate: true,
        entries: catalog.entries.map((entry) => ({
          ...entry,
          translation: { user: entry.source === "你好" ? "Hello" : "" },
        })),
      });

      const started = yield* launches.launch(game.id);
      const mkxpzDir = path.join(state, gameFiles(game.id).mkxpz);
      const log = path.join(state, gameFiles(game.id).logs, "mkxpz.log");
      assert.deepStrictEqual(
        yield* ended(game.id),
        Option.some({ ...started, phase: { _tag: "Exited", exitCode: 3 } }),
      );
      const [first, ...config] = (yield* fs.readFileString(log)).split("\n");
      assert.strictEqual(first, `started in ${mkxpzDir}`);
      const patches = path.join(mkxpzDir, "patches");
      assert.deepInclude(JSON.parse(config.join("\n")), {
        gameFolder: game.root,
        patches: [patches],
      });
      assert.sameMembers(yield* fs.readDirectory(path.join(patches, "Data")), [
        "Map001.rxdata",
        "Scripts.rxdata",
      ]);

      const map = path.join(patches, "Data", "Map001.rxdata");
      yield* fs.writeFileString(map, "kept");
      const again = Effect.fnUntraced(function* (english: string, translate = true) {
        const saved = yield* catalogs.get(game.id);
        yield* catalogs.save({
          ...saved,
          translate,
          entries: saved.entries.map((entry) =>
            entry.source === "你好" ? { ...entry, translation: { user: english } } : entry,
          ),
        });
        yield* launches.launch(game.id);
        yield* ended(game.id);
      });
      yield* again("Hello");
      assert.strictEqual(yield* fs.readFileString(map), "kept");
      yield* again("Hi there");
      assert.notStrictEqual(yield* fs.readFileString(map), "kept");
      yield* again("Hi there", false);
      assert.deepStrictEqual(yield* fs.readDirectory(path.join(patches, "Data")), []);
    }).pipe(Effect.provide(withFakeMkxpz)),
  { timeout: 60_000 },
);

it.live(
  "an XP game whose archive Unpack renamed plays its own data in mkxp-z, not the loose files copied over it",
  () =>
    Effect.gen(function* () {
      const launches = yield* Launches.Launches;
      const catalogs = yield* Catalogs.Catalogs;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const state = yield* StateDir;
      const map = xpFile(xpMap({ 1: [command(101, "你好")] }));
      const dir = yield* folderWith({
        "Game.rgssad.original": writeArchive(
          new Map([
            ["Data/System.rxdata", xpFile(rubyObject("RPG::System", {}))],
            ["Data/Map001.rxdata", map],
          ]),
        ),
        "Data/Map001.rxdata": xpFile(xpMap({ 1: [command(101, "Hello")] })),
      });
      const { game } = yield* opened(catalogs.inspect(dir));

      yield* launches.launch(game.id);
      yield* ended(game.id);
      const patches = path.join(state, gameFiles(game.id).mkxpz, "patches", "Data");
      assert.deepStrictEqual(yield* fs.readFile(path.join(patches, "Map001.rxdata")), map);
    }).pipe(Effect.provide(withFakeMkxpz)),
  { timeout: 60_000 },
);

it.live(
  "a game without a package.json opens in a window of its screen size, and a held game waits",
  () =>
    Effect.gen(function* () {
      const launches = yield* Launches.Launches;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const state = yield* StateDir;
      const game = yield* inspected({
        ...mvGame,
        "www/data/System.json": JSON.stringify({
          gameTitle: "雨",
          advanced: { screenWidth: 1280, screenHeight: 720 },
        }),
      });
      yield* launches.launch(game.id);
      const manifest = JSON.parse(
        yield* fs.readFileString(path.join(state, gameFiles(game.id).nwjsApp, "package.json")),
      );
      assert.deepStrictEqual(manifest.window, {
        title: "雨",
        width: 1280,
        height: 720,
        position: "center",
      });
      assert.strictEqual(manifest["chromium-args"], "--allow-file-access-from-files");
      yield* ended(game.id);

      const games = yield* Games.Games;
      const busy = yield* Effect.scoped(
        Effect.andThen(games.hold(game.id), Effect.flip(launches.launch(game.id))),
      );
      assert.strictEqual(busy._tag, "GameBusyError");
    }).pipe(Effect.provide(withFakeNw)),
  { timeout: 60_000 },
);

it.live("a game running in NW.js isn't started again until it has ended", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* folderWith({ nw: waitingNw });
    yield* fs.chmod(path.join(dir, "nw"), 0o755);
    yield* Effect.gen(function* () {
      const launches = yield* Launches.Launches;
      const game = yield* inspected(mvGame);
      yield* launches.launch(game.id);
      assert.strictEqual((yield* Effect.flip(launches.launch(game.id)))._tag, "GameRunningError");

      yield* fs.writeFileString(path.join(dir, "quit"), "");
      yield* ended(game.id);
      assert.strictEqual((yield* launches.launch(game.id)).phase._tag, "Running");
    }).pipe(Effect.provide(servicesWithNwjs(nwjsAt(path.join(dir, "nw")))));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("stopping ends the game's NW.js, and does nothing once it has ended", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* folderWith({ nw: signalledNw });
    yield* fs.chmod(path.join(dir, "nw"), 0o755);
    yield* Effect.gen(function* () {
      const launches = yield* Launches.Launches;
      const game = yield* inspected(mvGame);
      const started = yield* launches.launch(game.id);
      yield* launches.stop(game.id);
      assert.deepStrictEqual(
        yield* ended(game.id),
        Option.some({ ...started, phase: { _tag: "Stopped" } }),
      );
      yield* launches.stop(game.id);
      assert.strictEqual((yield* launches.launch(game.id)).phase._tag, "Running");
      yield* launches.stop(game.id);
    }).pipe(Effect.provide(servicesWithNwjs(nwjsAt(path.join(dir, "nw")))));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("starting needs NW.js downloaded and a listed game", () =>
  Effect.gen(function* () {
    const launches = yield* Launches.Launches;
    const game = yield* inspected(mvGame);
    const first = yield* Effect.flatMap(launches.changes(game.id), Stream.runHead);
    assert.isTrue(Option.isSome(first) && Option.isNone(first.value));
    const unknown = yield* Effect.flip(launches.changes("ffffffffffffffffffff"));
    assert.strictEqual(unknown._tag, "GameNotInspectedError");
    const missing = yield* Effect.flip(launches.launch(game.id));
    assert.strictEqual(missing._tag, "ProgramMissingError");
  }).pipe(Effect.provide(servicesWithNwjs(noPrograms.pipe(Layer.provide(FetchHttpClient.layer))))),
);

it("the command line quotes each word for sh, or for PowerShell on Windows", () => {
  const words = ["/opt/nw", "--log-file=it's here.log"];
  assert.strictEqual(
    Launches.commandLine(words, false),
    `'/opt/nw' '--log-file=it'\\''s here.log'`,
  );
  assert.strictEqual(
    Launches.commandLine([String.raw`C:\nw\nw.exe`, ...words.slice(1)], true),
    String.raw`& 'C:\nw\nw.exe' '--log-file=it''s here.log'`,
  );
});
