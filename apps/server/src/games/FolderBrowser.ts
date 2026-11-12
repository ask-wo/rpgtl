import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { FolderListing } from "@rpgtl/contracts";
import { OnWindows } from "../OnWindows.ts";

export class FolderUnreadableError extends Schema.TaggedError<FolderUnreadableError>()(
  "FolderUnreadableError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Can't read the folder ${this.path}.`;
  }
}

/**
 * The folders on this computer as the page's folder browser shows them, since a browser can't tell
 * a server the absolute path of a folder the user picked.
 */
export class FolderBrowser extends Context.Service<
  FolderBrowser,
  {
    /**
     * The folder where `typed` points, or the one holding it when it is a file or missing, or the
     * home folder, with its folders.
     */
    readonly list: (typed: string) => Effect.Effect<FolderListing, FolderUnreadableError>;
  }
>()("@rpgtl/server/games/FolderBrowser") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = yield* OnWindows;
  const home = yield* Config.String(windows ? "USERPROFILE" : "HOME");

  const isFolder = (folder: string) =>
    fs.stat(folder).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.catchTags({ PlatformError: () => Effect.succeed(false) }),
    );
  const isFile = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.catchTags({ PlatformError: () => Effect.succeed(false) }),
    );

  const startFolder = Effect.fn("FolderBrowser.startFolder")(function* (typed: string) {
    if (!typed.trim()) return home;
    const resolved = path.resolve(typed.trim());
    for (const folder of [resolved, path.dirname(resolved)])
      if (yield* isFolder(folder)) return folder;
    return home;
  });

  // The drives on Windows, checked each time since a USB drive comes and goes.
  const roots = windows
    ? Effect.filter(
        Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`),
        isFolder,
        { concurrency: "unbounded" },
      )
    : Effect.succeed(["/"]);

  const list = Effect.fn("FolderBrowser.list")(function* (typed: string) {
    const folder = yield* startFolder(typed);
    const names = yield* fs
      .readDirectory(folder)
      .pipe(Effect.mapError((cause) => new FolderUnreadableError({ path: folder, cause })));
    const entries = yield* Effect.forEach(
      names,
      (name) =>
        Effect.gen(function* () {
          const inside = path.join(folder, name);
          if (!(yield* isFolder(inside))) return Option.none();
          const game =
            (yield* isFile(path.join(inside, "data", "System.json"))) ||
            (yield* isFile(path.join(inside, "www", "data", "System.json"))) ||
            (yield* isFile(path.join(inside, "Game.rgssad"))) ||
            (yield* isFile(path.join(inside, "Data", "System.rxdata")));
          return Option.some({ name, path: inside, game });
        }),
      { concurrency: 16 },
    );
    const parent = path.dirname(folder);
    return {
      path: folder,
      parent: parent === folder ? null : parent,
      home,
      roots: yield* roots,
      folders: entries
        .flatMap(Option.toArray)
        .toSorted((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
        ),
    } satisfies FolderListing;
  });

  return FolderBrowser.of({ list });
});

export const layer = Layer.effect(FolderBrowser, make);
