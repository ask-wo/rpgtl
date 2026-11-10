import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { scriptFiles } from "@rpgtl/game/scripts";
import type { Connect, Plugin } from "vite-plus";
import * as SessionToken from "../auth/SessionToken.ts";

/** The scripts RPGTL puts into a game. */
export const ScriptFile = Schema.Literals(scriptFiles);
export type ScriptFile = typeof ScriptFile.Type;

export class FrontendFileError extends Schema.TaggedError<FrontendFileError>()(
  "FrontendFileError",
  { file: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Couldn't build ${this.file}.`;
  }
}

/** A file of the built page, by its path below `/`. */
export interface PageFile {
  readonly body: string | Uint8Array;
  readonly contentType: string;
}

/**
 * The page from `apps/web`: `Built` once by Vite, or served by Vite's dev server, which
 * rebuilds what changed and reloads the page, with `RPGTL_DEV=1`.
 */
export type Page = Data.TaggedEnum<{
  Built: {
    /** The file at a path such as `/assets/index-1a2b.js`, or the page itself at `/index.html`. */
    readonly file: (path: string) => Effect.Effect<Option.Option<PageFile>, FrontendFileError>;
  };
  Dev: { readonly middlewares: Connect.Server };
}>;
export const Page = Data.taggedEnum<Page>();

/**
 * RPGTL's page and the game scripts: built by Vite when first asked for, each time with
 * `RPGTL_DEV=1`, or read from a folder they were built into.
 */
export class Frontend extends Context.Service<
  Frontend,
  {
    readonly script: (file: ScriptFile) => Effect.Effect<string, FrontendFileError>;
    readonly page: Page;
  }
>()("@rpgtl/server/frontend/Frontend") {}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

const failed = (file: string) => (cause: unknown) => new FrontendFileError({ file, cause });

const pageFailed = (cause: unknown) => new FrontendFileError({ file: "the page", cause });

const withToken = (html: string, token: string) => html.replace("__TOKEN__", token);

const fileOf = (fileName: string, body: string | Uint8Array): PageFile => ({
  body,
  contentType:
    contentTypes[fileName.slice(fileName.lastIndexOf("."))] ?? "application/octet-stream",
});

// A failed build, such as one from a syntax error while editing, is tried again on the next request.
const untilBuilt = <A, E, R>(build: Effect.Effect<A, E, R>) =>
  Effect.cachedWithTTL(build, (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero));

// Vite is loaded only here, so a server reading prebuilt files runs without it.
const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const token = yield* SessionToken.SessionToken;
  const dev = yield* Config.String("RPGTL_DEV").pipe(
    Config.map((value) => value === "1"),
    Config.withDefault(false),
  );

  const resolve = (file: string, specifier: string) =>
    Effect.try({
      try: () => new URL(import.meta.resolve(specifier)),
      catch: failed(file),
    }).pipe(Effect.flatMap((url) => path.fromFileUrl(url).pipe(Effect.mapError(failed(file)))));

  const built = Effect.fn("Frontend.buildScript")(function* (file: ScriptFile) {
    return yield* Effect.tryPromise({
      try: () => import("@rpgtl/game/build").then(({ buildScript }) => buildScript(file)),
      catch: (cause) => new FrontendFileError({ file, cause }),
    });
  });

  /** The folder of `apps/web` and its Vite config. */
  const web = Effect.map(resolve("the page", "@rpgtl/web/package.json"), (file) => ({
    webRoot: path.dirname(file),
    configFile: path.join(path.dirname(file), "vite.config.ts"),
  }));

  const buildPage = Effect.fn("Frontend.buildPage")(function* () {
    const { webRoot, configFile } = yield* web;
    const result = yield* Effect.tryPromise({
      try: () =>
        import("vite-plus").then(({ build }) =>
          build({
            root: webRoot,
            configFile,
            logLevel: "silent",
            build: { write: false, reportCompressedSize: false },
          }),
        ),
      catch: pageFailed,
    });
    const files = new Map<string, PageFile>();
    for (const output of (Array.isArray(result) ? result : [result]).flatMap((item) =>
      "output" in item ? item.output : [],
    )) {
      const body =
        output.type === "chunk"
          ? output.code
          : output.fileName === "index.html" && typeof output.source === "string"
            ? withToken(output.source, token)
            : output.source;
      files.set(`/${output.fileName}`, fileOf(output.fileName, body));
    }
    if (!files.has("/index.html")) return yield* pageFailed("Vite built no index.html.");
    return files;
  });

  if (dev) {
    const tokenPlugin: Plugin = {
      name: "rpgtl:token",
      transformIndexHtml: (html) => withToken(html, token),
    };
    const { webRoot, configFile } = yield* web;
    const vite = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          import("vite-plus").then(({ createServer }) =>
            createServer({
              root: webRoot,
              configFile,
              plugins: [tokenPlugin],
              server: { middlewareMode: true },
            }),
          ),
        catch: pageFailed,
      }),
      (server) => Effect.promise(() => server.close()),
    );
    return Frontend.of({ script: built, page: Page.Dev({ middlewares: vite.middlewares }) });
  }

  const builtScripts = new Map(
    yield* Effect.forEach(ScriptFile.literals, (file) =>
      Effect.map(untilBuilt(built(file)), (once) => [file, once] as const),
    ),
  );
  const script = Effect.fn("Frontend.script")(function* (file: ScriptFile) {
    return yield* builtScripts.get(file) ?? built(file);
  });
  const builtPage = yield* untilBuilt(buildPage());
  const file = Effect.fn("Frontend.pageFile")(function* (filePath: string) {
    const files = yield* builtPage;
    return Option.fromUndefinedOr(files.get(filePath));
  });
  return Frontend.of({ script, page: Page.Built({ file }) });
});

export const layer = Layer.effect(Frontend, make);

/** The page and game scripts built into `folder`: the page in `page/`, the scripts in `game/`. */
export const layerPrebuilt = (folder: string) =>
  Layer.effect(
    Frontend,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const token = yield* SessionToken.SessionToken;
      const pageFolder = path.join(folder, "page");
      const files = new Map<string, PageFile>();
      for (const name of yield* fs
        .readDirectory(pageFolder, { recursive: true })
        .pipe(Effect.mapError(failed("the page")))) {
        const file = path.join(pageFolder, name);
        if ((yield* fs.stat(file).pipe(Effect.mapError(failed(name)))).type !== "File") continue;
        const url = `/${name.split(path.sep).join("/")}`;
        const body =
          url === "/index.html"
            ? withToken(yield* fs.readFileString(file).pipe(Effect.mapError(failed(name))), token)
            : yield* fs.readFile(file).pipe(Effect.mapError(failed(name)));
        files.set(url, fileOf(name, body));
      }
      if (!files.has("/index.html")) return yield* pageFailed(`No index.html in ${pageFolder}.`);
      const scripts = new Map(
        yield* Effect.forEach(ScriptFile.literals, (name) =>
          fs.readFileString(path.join(folder, "game", name)).pipe(
            Effect.mapError(failed(name)),
            Effect.map((text) => [name, text] as const),
          ),
        ),
      );
      return Frontend.of({
        script: Effect.fn("Frontend.script")(function* (name: ScriptFile) {
          return scripts.get(name) ?? (yield* failed(name)("It wasn't built."));
        }),
        page: Page.Built({
          file: (url) => Effect.succeed(Option.fromUndefinedOr(files.get(url))),
        }),
      });
    }),
  );
