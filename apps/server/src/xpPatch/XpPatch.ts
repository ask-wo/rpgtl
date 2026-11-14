import { gameFiles, type XpArchive } from "@rpgtl/contracts";
import {
  applyXpTranslations,
  type GameDataChanged,
  type GameFileInvalid,
  translatedByXpFile,
  xpArchiveName,
  xpImageTable,
  xpImageTableFile,
  xpPatchZip,
  xpUnpackedArchiveName,
} from "@rpgtl/domain";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Catalogs from "../games/Catalogs.ts";
import * as GameFolder from "../games/GameFolder.ts";
import * as Games from "../games/Games.ts";
import * as XpImages from "../imageText/XpImages.ts";
import * as Launches from "../nwjs/Launches.ts";
import * as StateFolder from "../state/StateFolder.ts";

/** Play still runs the game, whose files Unpack would change under it. */
class GameStillRunningError extends Schema.TaggedError<GameStillRunningError>()(
  "GameStillRunningError",
  { id: Schema.String },
) {
  override get message() {
    return `Game ${this.id} is running.`;
  }
}

/** The game's archive isn't in the state the operation needs, such as packed for Unpack. */
class ArchiveChangedError extends Schema.TaggedError<ArchiveChangedError>()("ArchiveChangedError", {
  id: Schema.String,
  expected: Schema.Literals(["packed", "unpacked"]),
}) {
  override get message() {
    return `Game ${this.id}'s archive isn't ${this.expected}.`;
  }
}

/** A file in the game's folder couldn't be written, renamed or deleted. */
export class GameFolderWriteError extends Schema.TaggedError<GameFolderWriteError>()(
  "GameFolderWriteError",
  { file: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Couldn't change ${this.file}.`;
  }
}

const written = (file: string) => (cause: unknown) => new GameFolderWriteError({ file, cause });

type ArchiveErrors =
  | Games.GameNotInspectedError
  | Games.EngineUnsupportedError
  | GameFolder.GameFileReadError;

type UnpackErrors =
  | ArchiveErrors
  | Games.GameBusyError
  | GameStillRunningError
  | ArchiveChangedError
  | GameFileInvalid
  | GameFolderWriteError;

/**
 * An XP game made playable in its own player, outside RPGTL: the patch of its translated data
 * files, and unpacking its archive, which `Game.exe` would otherwise load instead of the patch.
 * Unpacking is the one thing RPGTL writes into a game's folder, and only when the player asks.
 */
export class XpPatch extends Context.Service<
  XpPatch,
  {
    /**
     * A zip of the game's data files with their saved English applied, whatever the game's
     * translation switch says, the tiles that draw English into its images, and a readme of how
     * to use it.
     */
    readonly zip: (
      id: string,
    ) => Effect.Effect<
      Uint8Array,
      ArchiveErrors | GameFileInvalid | GameDataChanged | StateFolder.StateFileError
    >;
    readonly archive: (id: string) => Effect.Effect<XpArchive, ArchiveErrors>;
    /**
     * Writes each file of the game's archive into its folder, replacing loose files of the same
     * name as the archive did, then renames the archive. A loose file it replaces is first copied
     * into the game's state folder. A failure partway leaves the archive in place, so the game
     * plays as before.
     */
    readonly unpack: (id: string) => Effect.Effect<XpArchive, UnpackErrors>;
    /**
     * Names the archive back, then deletes the files in the game's folder that it holds, a
     * patch's too, puts back the game's own loose files that Unpack replaced, and deletes the
     * folders that leaves empty.
     */
    readonly pack: (id: string) => Effect.Effect<XpArchive, UnpackErrors>;
  }
>()("@rpgtl/server/xpPatch/XpPatch") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const games = yield* Games.Games;
  const catalogs = yield* Catalogs.Catalogs;
  const gameFolder = yield* GameFolder.GameFolder;
  const launches = yield* Launches.Launches;
  const xpImages = yield* XpImages.XpImages;
  const state = yield* StateFolder.StateFolder;
  const replacedFolder = (id: string) => path.join(state.root, gameFiles(id).unpackedOver);

  const xpGame = Effect.fnUntraced(function* (id: string) {
    const game = yield* games.get(id);
    yield* Games.requireFeature(game, "patch");
    return game;
  });

  const zip = Effect.fn("XpPatch.zip")(function* (id: string) {
    const game = yield* xpGame(id);
    const catalog = yield* catalogs.get(id);
    const translated = translatedByXpFile(catalog);
    const files = new Map<string, Uint8Array>();
    for (const [name, bytes] of yield* gameFolder.xpData(game)) {
      const entries = translated.get(name);
      if (!entries) continue;
      const patched = applyXpTranslations(name, bytes, entries);
      if (Result.isFailure(patched)) return yield* patched.failure;
      if (patched.success) files.set(name, patched.success);
    }
    const images = catalog.originalScripts ? [] : yield* xpImages.drawn(game);
    const graphics = new Map(images.map((image) => [`${image.tiles}.png`, image.bytes]));
    if (images.length > 0) graphics.set(xpImageTableFile, xpImageTable(images));
    return xpPatchZip(game.title, files, graphics);
  });

  const archive = Effect.fn("XpPatch.archive")(function* (id: string) {
    const found = yield* gameFolder.xpArchive(yield* xpGame(id));
    if (Option.isNone(found)) return "none" as const;
    return found.value.unpacked ? ("unpacked" as const) : ("packed" as const);
  });

  const changeArchive = Effect.fnUntraced(function* <E>(
    id: string,
    expected: "packed" | "unpacked",
    change: (
      root: string,
      file: string,
    ) => Effect.Effect<void, E | GameFolder.GameFileReadError | GameFileInvalid>,
  ) {
    const game = yield* xpGame(id);
    return yield* games.exclusive(
      id,
      Effect.gen(function* () {
        const last = Option.flatten(yield* Stream.runHead(yield* launches.changes(id)));
        if (Option.isSome(last) && last.value.phase._tag === "Running")
          return yield* new GameStillRunningError({ id });
        const found = yield* gameFolder.xpArchive(game);
        if (Option.isNone(found) || found.value.unpacked !== (expected === "unpacked"))
          return yield* new ArchiveChangedError({ id, expected });
        yield* Effect.uninterruptible(change(game.root, found.value.file));
        return expected === "packed" ? ("unpacked" as const) : ("packed" as const);
      }),
    );
  });

  /** The path in `root` of an archive's file, or none when its name would leave `root`. */
  const inside = (root: string, stored: string) => {
    const target = path.resolve(root, stored);
    return target.startsWith(path.resolve(root) + path.sep) ? Option.some(target) : Option.none();
  };

  const unpack = Effect.fn("XpPatch.unpack")(function* (id: string) {
    return yield* changeArchive(id, "packed", (root, file) =>
      Effect.gen(function* () {
        // A second archive, such as a new version copied in after an Unpack, would replace it.
        const renamed = path.join(path.dirname(file), xpUnpackedArchiveName);
        if (yield* fs.exists(renamed).pipe(Effect.mapError(written(renamed))))
          return yield* new ArchiveChangedError({ id, expected: "packed" });
        yield* gameFolder.xpArchiveFiles(file, (entries, content) =>
          Effect.forEach(
            entries,
            (entry) =>
              Option.match(inside(root, entry.path), {
                onNone: () => Effect.logWarning(`Left out ${entry.path}, outside the game folder.`),
                onSome: (target) =>
                  Effect.gen(function* () {
                    const bytes = yield* content(entry);
                    const kept = path.join(replacedFolder(id), path.relative(root, target));
                    // After an Unpack that failed partway, the file there may be the archive's.
                    if ((yield* fs.exists(target)) && !(yield* fs.exists(kept))) {
                      yield* fs.makeDirectory(path.dirname(kept), { recursive: true });
                      yield* fs.copyFile(target, kept);
                    }
                    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
                    yield* fs.writeFile(target, bytes);
                  }).pipe(
                    Effect.catchTags({
                      PlatformError: (cause) => Effect.fail(written(target)(cause)),
                    }),
                  ),
              }),
            { discard: true },
          ),
        );
        yield* fs.rename(file, renamed).pipe(Effect.mapError(written(file)));
      }),
    );
  });

  const pack = Effect.fn("XpPatch.pack")(function* (id: string) {
    return yield* changeArchive(id, "unpacked", (root, file) =>
      Effect.gen(function* () {
        const packed = path.join(path.dirname(file), xpArchiveName);
        yield* fs.rename(file, packed).pipe(Effect.mapError(written(file)));
        yield* gameFolder.xpArchiveFiles(packed, (entries) =>
          Effect.gen(function* () {
            const folders = new Set<string>();
            for (const entry of entries) {
              const target = inside(root, entry.path);
              if (Option.isNone(target)) continue;
              yield* fs
                .remove(target.value, { force: true })
                .pipe(Effect.mapError(written(target.value)));
              const kept = path.join(replacedFolder(id), path.relative(root, target.value));
              if (yield* fs.exists(kept).pipe(Effect.mapError(written(kept))))
                yield* fs.copyFile(kept, target.value).pipe(Effect.mapError(written(target.value)));
              const top = path.resolve(root);
              for (let dir = path.dirname(target.value); dir !== top; dir = path.dirname(dir))
                folders.add(dir);
            }
            // Deepest first, so a folder's emptied subfolders are gone before it is looked at.
            for (const dir of [...folders].toSorted((a, b) => b.length - a.length)) {
              const empty = yield* fs.readDirectory(dir).pipe(
                Effect.map((names) => names.length === 0),
                // A folder that can't be listed is left in place, as one that isn't empty.
                Effect.catchTags({ PlatformError: () => Effect.succeed(false) }),
              );
              if (empty)
                yield* fs.remove(dir, { recursive: true }).pipe(Effect.mapError(written(dir)));
            }
          }),
        );
        yield* fs
          .remove(replacedFolder(id), { recursive: true, force: true })
          .pipe(Effect.mapError(written(replacedFolder(id))));
      }),
    );
  });

  return XpPatch.of({ zip, archive, unpack, pack });
});

export const layer = Layer.effect(XpPatch, make);
