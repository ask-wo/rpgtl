import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { OnWindows } from "../OnWindows.ts";
import { ChildEnvironment } from "./ChildEnvironment.ts";

/**
 * The file of the program `name` as the CLIs' environment finds it: `name` itself when it is a
 * path, else the first match on its `PATH`, trying each `PATHEXT` ending on Windows. Node starts no
 * batch file without a shell, so for the `.cmd` file npm installs on Windows it gives the file that
 * file starts: a Node script or a program.
 */
export const findProgram = Effect.fn("findProgram")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* ChildEnvironment;
  const windows = yield* OnWindows;
  const isFile = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.catchTags({ PlatformError: () => Effect.succeed(false) }),
    );
  // npm's shim ends with `… "%dp0%\<target>" %*`, %dp0% being the shim's own folder.
  const shimTarget = Effect.fn("findProgram.shimTarget")(function* (file: string) {
    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.catchTags({ PlatformError: () => Effect.succeed("") }));
    const last = text.split(/\r?\n/).findLast((line) => line.includes("%*")) ?? "";
    const target = [...last.matchAll(/"%dp0%\\([^"]+)"/g)].at(-1)?.[1];
    if (target === undefined) return Option.none<string>();
    const resolved = path.join(path.dirname(file), ...target.split("\\"));
    return (yield* isFile(resolved)) ? Option.some(resolved) : Option.none<string>();
  });
  const found = Effect.fn("findProgram.found")(function* (file: string) {
    if (!(yield* isFile(file))) return Option.none<string>();
    return windows && /\.(?:cmd|bat)$/i.test(file) ? yield* shimTarget(file) : Option.some(file);
  });
  if (path.isAbsolute(name)) return yield* found(name);
  const endings = windows
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const folder of (environment.PATH ?? "").split(windows ? ";" : ":").filter(Boolean))
    for (const ending of endings) {
      const file = yield* found(path.join(folder, name + ending));
      if (Option.isSome(file)) return file;
    }
  return Option.none<string>();
});

/** Whether `file` is a Node script, which starts through Node rather than on its own. */
export const isNodeScript = (file: string) => /\.[cm]?js$/i.test(file);
