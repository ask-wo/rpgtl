import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { buildScript } from "@rpgtl/game/build";
import { scriptFiles } from "@rpgtl/game/scripts";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { build } from "vite-plus";
import { setupFiles } from "./imageText/ImageReaderSetup.ts";

/** The Node.js each download carries, checked against the SHA-256 from nodejs.org. */
const node = {
  version: "26.13.0",
  "linux-x64": {
    file: "node-v26.13.0-linux-x64.tar.xz",
    sha256: "d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997",
    binary: "bin/node",
  },
  "win-x64": {
    file: "node-v26.13.0-win-x64.zip",
    sha256: "dcc60d59a0746999f99064a01c020445d54d84228c691cdbf25b49ac3b59150a",
    binary: "node.exe",
  },
} as const;

const targets = ["linux-x64", "win-x64"] as const;
type Target = (typeof targets)[number];

/**
 * The native part of `@napi-rs/canvas` each download carries, checked against npm's integrity.
 * pnpm installs only this computer's, so the build fetches the one for the download's system.
 */
const canvas = {
  version: "1.1.1",
  "linux-x64": {
    name: "canvas-linux-x64-gnu",
    integrity:
      "sha512-7bZfDI9lxKqj9wJRHiSQBimCRanxDGHYE7TugnOmFJ9ScpgFSsLHFQtOH9wvmbQvBwv5nBuDBGJlG0+7iGkN+w==",
  },
  "win-x64": {
    name: "canvas-win32-x64-msvc",
    integrity:
      "sha512-6Ge1AF1SVO+Ypjaw9IPcApm95krR3GQ32HgVqlIckbN/WqUlWYS0hnb8ZIdu3e0IbutbJgd8D2qSeb2/Cdpbdw==",
  },
} as const;

/** The lettering fonts' files, which `LetteringFontFiles` in the download points at. */
const letteringFonts = [
  "noto-sans/files/noto-sans-latin-400-normal.woff2",
  "noto-sans/files/noto-sans-latin-700-normal.woff2",
  "noto-serif/files/noto-serif-latin-400-normal.woff2",
  "noto-serif/files/noto-serif-latin-700-normal.woff2",
  "noto-sans/LICENSE",
  "noto-serif/LICENSE",
] as const;

/** The image reader's Python project, without its tests and comparison tools. */
const readerFiles = [
  "server.py",
  "worker.py",
  "ocr.py",
  "lettering.py",
  "models.py",
  ...setupFiles,
];

// Without arguments the launcher starts the server, with them the command-line tools; both keep
// their state in the user's data folder unless RPGTL_DIR says otherwise.
const launchers: Record<Target, { readonly name: string; readonly text: string }> = {
  "linux-x64": {
    name: "rpgtl",
    text: `#!/bin/sh
here=$(dirname "$(readlink -f "$0")")
: "\${RPGTL_DIR:=\${XDG_DATA_HOME:-$HOME/.local/share}/rpgtl}"
export RPGTL_DIR
if [ $# -eq 0 ]; then exec "$here/node/node" "$here/app/server.mjs"; fi
exec "$here/node/node" "$here/app/cli.mjs" "$@"
`,
  },
  "win-x64": {
    name: "rpgtl.cmd",
    text: [
      "@echo off",
      'if not defined RPGTL_DIR set "RPGTL_DIR=%LOCALAPPDATA%\\rpgtl\\data"',
      'if "%~1"=="" (',
      '  "%~dp0node\\node.exe" "%~dp0app\\server.mjs"',
      "  if errorlevel 1 pause",
      ") else (",
      '  "%~dp0node\\node.exe" "%~dp0app\\cli.mjs" %*',
      ")",
      "",
    ].join("\r\n"),
  },
};

class BuildFailed extends Schema.TaggedError<BuildFailed>()("BuildFailed", {
  step: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Building the download failed: ${this.step}.`;
  }
}

const buildArchive = Effect.fn("buildArchive")(function* (target: Target) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const client = yield* HttpClient.HttpClient;
  const failed = (step: string) => (cause: unknown) => new BuildFailed({ step, cause });
  const run = (step: string, command: string, args: ReadonlyArray<string>, cwd?: string) =>
    spawner.exitCode(ChildProcess.make(command, args, { cwd, stdout: "inherit" })).pipe(
      Effect.mapError(failed(step)),
      Effect.flatMap((code) => (code === 0 ? Effect.void : Effect.fail(new BuildFailed({ step })))),
    );

  const repo = path.resolve(import.meta.dirname, "../../..");
  const dist = path.join(repo, "dist");
  const staging = path.join(dist, target);
  const top = path.join(staging, "rpgtl");
  const app = path.join(top, "app");
  const version = JSON.parse(
    yield* fs.readFileString(path.join(repo, "package.json")).pipe(Effect.mapError(failed("read"))),
  ).version;
  const commit = (yield* spawner
    .string(ChildProcess.make("git", ["-C", repo, "rev-parse", "--short", "HEAD"]))
    .pipe(Effect.mapError(failed("git")))).trim();

  yield* fs
    .remove(staging, { recursive: true, force: true })
    .pipe(Effect.mapError(failed("clean")));
  yield* fs
    .makeDirectory(path.join(app, "game"), { recursive: true })
    .pipe(Effect.mapError(failed("make folders")));

  yield* Console.log("Building the page…");
  const web = path.dirname(
    yield* path
      .fromFileUrl(new URL(import.meta.resolve("@rpgtl/web/package.json")))
      .pipe(Effect.mapError(failed("find the page"))),
  );
  yield* Effect.tryPromise({
    try: () =>
      build({
        root: web,
        configFile: path.join(web, "vite.config.ts"),
        logLevel: "warn",
        build: { outDir: path.join(app, "page"), emptyOutDir: true, reportCompressedSize: false },
      }),
    catch: failed("build the page"),
  });

  yield* Console.log("Building the game scripts…");
  for (const file of scriptFiles) {
    const text = yield* Effect.tryPromise({
      try: () => buildScript(file),
      catch: failed(`build ${file}`),
    });
    yield* fs
      .writeFileString(path.join(app, "game", file), text)
      .pipe(Effect.mapError(failed("write")));
  }

  yield* Console.log("Bundling the server and command-line tools…");
  yield* Effect.tryPromise({
    try: () =>
      build({
        configFile: false,
        root: import.meta.dirname,
        logLevel: "warn",
        define: { RPGTL_BUILT_COMMIT: JSON.stringify(commit) },
        ssr: { noExternal: true, target: "node" },
        build: {
          ssr: true,
          outDir: app,
          emptyOutDir: false,
          minify: false,
          reportCompressedSize: false,
          rollupOptions: {
            input: {
              server: path.join(import.meta.dirname, "portable.ts"),
              cli: path.join(import.meta.dirname, "bin.ts"),
            },
            // Only the Vite layer loads these, which the download never uses. The canvas loads
            // its native part, which the download carries in its node_modules.
            external: ["vite-plus", "@rpgtl/game/build", "@napi-rs/canvas"],
            output: {
              format: "es",
              entryFileNames: "[name].mjs",
              chunkFileNames: "chunks/[name]-[hash].mjs",
            },
          },
        },
      }),
    catch: failed("bundle the server"),
  });

  yield* Console.log(`Adding Node.js ${node.version}…`);
  const release = node[target];
  const cache = path.join(dist, "node-cache");
  const archive = path.join(cache, release.file);
  yield* fs.makeDirectory(cache, { recursive: true }).pipe(Effect.mapError(failed("cache")));
  const sha256 = (file: string) =>
    fs.stream(file).pipe(
      Stream.runFold(
        () => createHash("sha256"),
        (hash, chunk) => hash.update(chunk),
      ),
      Effect.map((hash) => hash.digest("hex")),
      Effect.mapError(failed("hash Node.js")),
    );
  const cached = yield* fs.exists(archive).pipe(Effect.mapError(failed("cache")));
  if (!cached || (yield* sha256(archive)) !== release.sha256) {
    const response = yield* client
      .get(`https://nodejs.org/dist/v${node.version}/${release.file}`)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.mapError(failed("download")));
    yield* response.stream.pipe(Stream.run(fs.sink(archive)), Effect.mapError(failed("download")));
  }
  if ((yield* sha256(archive)) !== release.sha256)
    return yield* new BuildFailed({ step: `Node.js's SHA-256 doesn't match for ${release.file}` });
  const unpacked = path.join(staging, "node-unpacked");
  yield* fs.makeDirectory(unpacked).pipe(Effect.mapError(failed("unpack Node.js")));
  yield* release.file.endsWith(".zip")
    ? run("unpack Node.js", "unzip", ["-q", archive, "-d", unpacked])
    : run("unpack Node.js", "tar", ["-xJf", archive, "-C", unpacked]);
  const nodeRoot = path.join(unpacked, release.file.replace(/\.(zip|tar\.xz)$/, ""));
  const nodeDir = path.join(top, "node");
  yield* fs.makeDirectory(nodeDir).pipe(Effect.mapError(failed("add Node.js")));
  const binary = path.join(nodeDir, path.basename(release.binary));
  yield* fs
    .copyFile(path.join(nodeRoot, release.binary), binary)
    .pipe(Effect.mapError(failed("add Node.js")));
  yield* fs.chmod(binary, 0o755).pipe(Effect.mapError(failed("add Node.js")));
  yield* fs
    .copyFile(path.join(nodeRoot, "LICENSE"), path.join(nodeDir, "LICENSE"))
    .pipe(Effect.mapError(failed("add Node.js")));
  yield* fs.remove(unpacked, { recursive: true }).pipe(Effect.mapError(failed("clean")));

  yield* Console.log(`Adding @napi-rs/canvas ${canvas.version}…`);
  const canvasJs = path.dirname(
    yield* path
      .fromFileUrl(new URL(import.meta.resolve("@napi-rs/canvas/package.json")))
      .pipe(Effect.mapError(failed("find @napi-rs/canvas"))),
  );
  const installed = JSON.parse(
    yield* fs
      .readFileString(path.join(canvasJs, "package.json"))
      .pipe(Effect.mapError(failed("read @napi-rs/canvas"))),
  ).version;
  if (installed !== canvas.version)
    return yield* new BuildFailed({
      step: `@napi-rs/canvas is ${installed}, but the build fetches ${canvas.version}`,
    });
  const modules = path.join(app, "node_modules", "@napi-rs");
  yield* fs
    .copy(canvasJs, path.join(modules, "canvas"))
    .pipe(Effect.mapError(failed("add @napi-rs/canvas")));
  const native = canvas[target];
  const tarball = path.join(cache, `${native.name}-${canvas.version}.tgz`);
  const integrity = (file: string) =>
    fs.stream(file).pipe(
      Stream.runFold(
        () => createHash("sha512"),
        (hash, chunk) => hash.update(chunk),
      ),
      Effect.map((hash) => `sha512-${hash.digest("base64")}`),
      Effect.mapError(failed("hash @napi-rs/canvas")),
    );
  if (
    !(yield* fs.exists(tarball).pipe(Effect.mapError(failed("cache")))) ||
    (yield* integrity(tarball)) !== native.integrity
  ) {
    const response = yield* client
      .get(
        `https://registry.npmjs.org/@napi-rs/${native.name}/-/${native.name}-${canvas.version}.tgz`,
      )
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.mapError(failed("download")));
    yield* response.stream.pipe(Stream.run(fs.sink(tarball)), Effect.mapError(failed("download")));
  }
  if ((yield* integrity(tarball)) !== native.integrity)
    return yield* new BuildFailed({ step: `@napi-rs/${native.name}'s integrity doesn't match` });
  const nativeDir = path.join(modules, native.name);
  yield* fs
    .makeDirectory(nativeDir, { recursive: true })
    .pipe(Effect.mapError(failed("add @napi-rs/canvas")));
  yield* run("unpack @napi-rs/canvas", "tar", [
    "-xzf",
    tarball,
    "-C",
    nativeDir,
    "--strip-components=1",
  ]);

  for (const file of letteringFonts) {
    const [family = "", ...rest] = file.split("/");
    const found = yield* path
      .fromFileUrl(new URL(import.meta.resolve(`@fontsource/${family}/package.json`)))
      .pipe(Effect.mapError(failed("find the lettering fonts")));
    const name = rest.join("/") === "LICENSE" ? `LICENSE-${family}` : path.basename(file);
    yield* fs
      .makeDirectory(path.join(app, "fonts"), { recursive: true })
      .pipe(Effect.mapError(failed("add the lettering fonts")));
    yield* fs
      .copyFile(path.join(path.dirname(found), ...rest), path.join(app, "fonts", name))
      .pipe(Effect.mapError(failed("add the lettering fonts")));
  }

  // RPGTL sets the image reader up from these with uv; see ImageReaderSetup.
  for (const file of readerFiles) {
    const copy = path.join(app, "image-reader", file);
    yield* fs
      .makeDirectory(path.dirname(copy), { recursive: true })
      .pipe(Effect.mapError(failed("add the image reader")));
    yield* fs
      .copyFile(path.join(repo, "apps/image-reader", file), copy)
      .pipe(Effect.mapError(failed("add the image reader")));
  }

  const launcher = launchers[target];
  yield* fs
    .writeFileString(path.join(top, launcher.name), launcher.text)
    .pipe(Effect.mapError(failed("write the launcher")));
  yield* fs
    .chmod(path.join(top, launcher.name), 0o755)
    .pipe(Effect.mapError(failed("write the launcher")));
  yield* fs
    .copyFile(path.join(repo, "README.md"), path.join(top, "README.md"))
    .pipe(Effect.mapError(failed("add the README")));
  yield* fs
    .copyFile(path.join(repo, "LICENSE"), path.join(top, "LICENSE"))
    .pipe(Effect.mapError(failed("add the license")));

  const name = `rpgtl-${version}-${target}`;
  const output = path.join(dist, target === "win-x64" ? `${name}.zip` : `${name}.tar.gz`);
  yield* fs.remove(output, { force: true }).pipe(Effect.mapError(failed("clean")));
  yield* target === "win-x64"
    ? run("pack", "zip", ["-qr", output, "rpgtl"], staging)
    : run("pack", "tar", ["-czf", output, "-C", staging, "rpgtl"]);
  yield* Console.log(`Built ${output}`);
});

const command = Command.make(
  "build-archive",
  {
    target: Flag.Literals("target", targets).pipe(
      Flag.withDescription("The system the download is for"),
    ),
  },
  ({ target }) => buildArchive(target),
).pipe(Command.withDescription("Build RPGTL's portable download into dist/"));

Command.run(command, { version: "0.1.0" }).pipe(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- the build script's entry point
  Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)),
  NodeRuntime.runMain,
);
