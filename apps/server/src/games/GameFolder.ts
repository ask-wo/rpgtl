import { createHash } from "node:crypto";
import type { Entry, Game, Plugins } from "@rpgtl/contracts";
import {
  bootEngines,
  coreScripts,
  decodeGameFile,
  decodePlugins,
  folderVersion,
  gameEntries,
  type GameContents,
  GameFileInvalid,
  type GameImage,
  imageExtension,
  mediaNames,
  mediaReferences,
  mediaWarnings,
  missingFiles,
  referencedFolders,
  textImages,
} from "@rpgtl/domain";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export class GamePathEmptyError extends Schema.TaggedError<GamePathEmptyError>()(
  "GamePathEmptyError",
  {},
) {
  override get message() {
    return "No game folder given.";
  }
}

/** A path with no unpacked RPG Maker MV or MZ game in it or in its `www` folder. */
export class NoGameFoundError extends Schema.TaggedError<NoGameFoundError>()("NoGameFoundError", {
  path: Schema.String,
}) {
  override get message() {
    return `No RPG Maker MV or MZ game at ${this.path}.`;
  }
}

/** A file the game needs that isn't a file in its folder. */
export class GameFileMissingError extends Schema.TaggedError<GameFileMissingError>()(
  "GameFileMissingError",
  { file: Schema.String },
) {
  override get message() {
    return `${this.file} isn't a file in the game folder.`;
  }
}

/** A file or folder of the game that is there but can't be read. */
export class GameFileReadError extends Schema.TaggedError<GameFileReadError>()(
  "GameFileReadError",
  { file: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Couldn't read ${this.file}.`;
  }
}

/** What a game folder holds, as `games.json` lists it apart from the id RPGTL gives the game. */
export type FolderGame = Omit<Game, "id">;

/** A game's own folder: what it is, and the text in its data files and plugin settings. */
export class GameFolder extends Context.Service<
  GameFolder,
  {
    /** The game in the folder at `path`, its `www` folder, or the folder of the file at `path`. */
    readonly inspect: (
      path: string,
    ) => Effect.Effect<
      FolderGame,
      | GamePathEmptyError
      | NoGameFoundError
      | GameFileMissingError
      | GameFileReadError
      | GameFileInvalid
    >;
    /** Whether the game's web folder still holds its `data/System.json`, without reading it. */
    readonly present: (game: FolderGame) => Effect.Effect<boolean, GameFileReadError>;
    /**
     * The extension of the game's image files and the key its encrypted images need, from its
     * `data/System.json`.
     */
    readonly imageEncoding: (
      game: FolderGame,
    ) => Effect.Effect<
      { readonly extension: string; readonly key: Option.Option<string> },
      GameFileMissingError | GameFileReadError | GameFileInvalid
    >;
    /** The game's images that may hold text, and the key its encrypted images need. */
    readonly textImages: (
      game: FolderGame,
    ) => Effect.Effect<
      { readonly images: ReadonlyArray<GameImage>; readonly key: Option.Option<string> },
      GameFileMissingError | GameFileReadError | GameFileInvalid
    >;
    /**
     * The real path of the game's file at `relative`, a path below its web folder whose letter
     * case may differ from the file's, as Windows finds files.
     */
    readonly find: (
      game: FolderGame,
      relative: string,
    ) => Effect.Effect<string, GameFileMissingError | GameFileReadError>;
    /** The files below the game's `img/` folder, as paths below its web folder. */
    readonly images: (game: FolderGame) => Effect.Effect<ReadonlyArray<string>, GameFileReadError>;
    /** The bytes of the game's file at `relative`, as `find` finds it. */
    readonly readFile: (
      game: FolderGame,
      relative: string,
    ) => Effect.Effect<Uint8Array, GameFileMissingError | GameFileReadError>;
    /** The text of the game's data files and plugin settings, untranslated. */
    readonly entries: (
      game: FolderGame,
    ) => Effect.Effect<
      ReadonlyArray<Entry>,
      GameFileMissingError | GameFileReadError | GameFileInvalid
    >;
    /**
     * Every data file, whether RPGTL extracts its text or not, the plugin list and the code of
     * the plugins, for searches of all of the game.
     */
    readonly contents: (
      game: FolderGame,
    ) => Effect.Effect<GameContents, GameFileReadError | GameFileInvalid>;
  }
>()("@rpgtl/server/games/GameFolder") {}

const unreadable = (file: string) => (cause: unknown) => new GameFileReadError({ file, cause });

/** Runs `missing` when nothing is at `file`; any other failure is a read error. */
const ifMissing =
  <B, E2>(file: string, missing: Effect.Effect<B, E2>) =>
  <A, R>(effect: Effect.Effect<A, PlatformError.PlatformError, R>) =>
    effect.pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? missing : Effect.fail(unreadable(file)(error)),
      }),
    );

/** What inspecting and reading images read from System.json. */
const SystemHeader = Schema.Struct({
  gameTitle: Schema.optionalKey(Schema.String),
  versionId: Schema.optionalKey(Schema.Finite),
  advanced: Schema.optionalKey(Schema.Struct({ gameId: Schema.optionalKey(Schema.Finite) })),
  hasEncryptedImages: Schema.optionalKey(Schema.Boolean),
  hasEncryptedAudio: Schema.optionalKey(Schema.Boolean),
  encryptionKey: Schema.optionalKey(Schema.String),
});

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const isFile = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.type === "File"),
      ifMissing(file, Effect.succeed(false)),
    );

  // The helpers that read one file are untraced: they run for every data file and plugin, inside
  // the spans of `inspect` and `entries`.
  /** The file at `relative` below `root`, or none when it is missing or outside `root`. */
  const fileInside = Effect.fnUntraced(function* (root: string, relative: string) {
    const real = yield* fs.realPath(root).pipe(Effect.mapError(unreadable(root)));
    const resolved = path.resolve(real, relative);
    const file = yield* fs
      .realPath(resolved)
      .pipe(Effect.asSome, ifMissing(resolved, Effect.succeed(Option.none<string>())));
    if (Option.isNone(file)) return Option.none<string>();
    const below = path.relative(real, file.value);
    if (below === ".." || below.startsWith(`..${path.sep}`) || path.isAbsolute(below))
      return Option.none<string>();
    return (yield* isFile(file.value)) ? file : Option.none<string>();
  });
  /** The text of the file at `relative` below `root`, or none when there is no such file. */
  const textInside = Effect.fnUntraced(function* (root: string, relative: string) {
    const file = yield* fileInside(root, relative);
    if (Option.isNone(file)) return Option.none<string>();
    return yield* fs
      .readFileString(file.value)
      .pipe(Effect.asSome, Effect.mapError(unreadable(file.value)));
  });
  const requiredText = Effect.fnUntraced(function* (root: string, relative: string) {
    const text = yield* textInside(root, relative);
    if (Option.isNone(text))
      return yield* new GameFileMissingError({ file: path.join(root, relative) });
    return text.value;
  });

  /** The files below `dir`, as paths below it with `/` between folders; none when it is missing. */
  const filesUnder = (dir: string): Effect.Effect<ReadonlyArray<string>, GameFileReadError> =>
    fs.readDirectoryEntries(dir).pipe(
      ifMissing(dir, Effect.succeed([])),
      Effect.flatMap((entries) =>
        Effect.forEach(entries, (entry) =>
          entry.type === "Directory"
            ? Effect.map(filesUnder(path.join(dir, entry.name)), (files) =>
                files.map((file) => `${entry.name}/${file}`),
              )
            : Effect.succeed(entry.type === "File" ? [entry.name] : []),
        ),
      ),
      Effect.map((lists) => lists.flat()),
    );
  const namesIn = (dir: string) =>
    fs.readDirectory(dir).pipe(ifMissing(dir, Effect.succeed<ReadonlyArray<string>>([])));

  const systemHeader = Effect.fnUntraced(function* (webRoot: string) {
    const text = yield* requiredText(webRoot, "data/System.json");
    const file = yield* Effect.fromResult(decodeGameFile("System.json", text));
    return yield* Schema.decodeUnknownEffect(SystemHeader)(file.data).pipe(
      Effect.mapError(
        (error) => new GameFileInvalid({ file: "System.json", problem: error.message }),
      ),
    );
  });
  /** The data file decoded, or none when the game has no such file. */
  const dataFile = Effect.fnUntraced(function* (game: FolderGame, file: string) {
    const text = yield* textInside(game.webRoot, `data/${file}`);
    if (Option.isNone(text)) return Option.none();
    return Option.some(yield* Effect.fromResult(decodeGameFile(file, text.value)));
  });

  const engineAt = Effect.fn("GameFolder.engineAt")(function* (webRoot: string) {
    if (!(yield* isFile(path.join(webRoot, "index.html")))) return Option.none();
    const html = yield* requiredText(webRoot, "index.html");
    const main = Option.getOrElse(yield* textInside(webRoot, "js/main.js"), () => "");
    for (const engine of bootEngines(html, main))
      if (yield* isFile(path.join(webRoot, "js", coreScripts[engine]))) return Option.some(engine);
    return Option.none();
  });

  /** The day the newest of the data files was changed, as `2024-05-01`. */
  const newestDate = Effect.fnUntraced(function* (dataDir: string, files: ReadonlyArray<string>) {
    const times = yield* Effect.forEach(files, (file) =>
      fs.stat(path.join(dataDir, file)).pipe(
        Effect.map((info) => Option.getOrElse(Option.map(info.mtime, Number), () => 0)),
        Effect.mapError(unreadable(path.join(dataDir, file))),
      ),
    );
    return DateTime.formatIsoDateUtc(DateTime.makeUnsafe(Math.max(0, ...times)));
  });

  const gameAt = Effect.fn("GameFolder.gameAt")(function* (
    root: string,
    webRoot: string,
    engine: Game["engine"],
  ) {
    const system = yield* systemHeader(webRoot);
    const dataDir = path.join(webRoot, "data");
    const files = (yield* fs.readDirectory(dataDir).pipe(Effect.mapError(unreadable(dataDir))))
      .filter((file) => file.endsWith(".json"))
      .toSorted();
    const hash = createHash("sha256");
    const references = yield* Effect.forEach(files, (file) =>
      requiredText(dataDir, file).pipe(
        Effect.tap((text) => Effect.sync(() => hash.update(`${file}\0${text}\0`))),
        Effect.flatMap((text) => Effect.fromResult(decodeGameFile(file, text))),
        Effect.map((data) => mediaReferences(file, data.data)),
      ),
    );
    hash.update(Option.getOrElse(yield* textInside(webRoot, "js/plugins.js"), () => ""));
    const asked = references.flat();
    const folders = new Map(
      yield* Effect.forEach(referencedFolders(asked), (folder) =>
        Effect.map(
          namesIn(path.join(webRoot, folder)),
          (names) => [folder, mediaNames(folder, names)] as const,
        ),
      ),
    );
    const missing = missingFiles(asked, folders);
    return {
      root,
      webRoot,
      engine,
      title: system.gameTitle || path.basename(root),
      files,
      encryptedAssets: Boolean(system.hasEncryptedImages || system.hasEncryptedAudio),
      mediaWarnings: mediaWarnings(yield* filesUnder(webRoot)),
      missingImages: missing.filter((file) => file.path.startsWith("img/")),
      missingAudio: missing.filter((file) => file.path.startsWith("audio/")),
      identity: {
        ...(system.advanced?.gameId !== undefined && { gameId: system.advanced.gameId }),
        ...(system.encryptionKey && { encryptionKey: system.encryptionKey }),
      },
      build: {
        ...(system.versionId !== undefined && { versionId: system.versionId }),
        sha256: hash.digest("hex"),
        label: folderVersion(path.basename(root)) ?? (yield* newestDate(dataDir, files)),
      },
    } satisfies FolderGame;
  });

  const inspect = Effect.fn("GameFolder.inspect")(function* (input: string) {
    if (!input.trim()) return yield* new GamePathEmptyError();
    const given = path.resolve(input.trim());
    const real = yield* fs
      .realPath(given)
      .pipe(ifMissing(given, Effect.fail(new NoGameFoundError({ path: given }))));
    const root = (yield* isFile(real)) ? path.dirname(real) : real;
    for (const webRoot of [root, path.join(root, "www")]) {
      const engine = yield* engineAt(webRoot);
      if (Option.isSome(engine)) return yield* gameAt(root, webRoot, engine.value);
    }
    return yield* new NoGameFoundError({ path: given });
  });

  const pluginList = Effect.fnUntraced(function* (game: FolderGame) {
    return yield* Effect.fromResult(
      decodePlugins(Option.getOrElse(yield* textInside(game.webRoot, "js/plugins.js"), () => "[]")),
    );
  });
  /** The code of each listed plugin whose file is there, by name. */
  const pluginCode = Effect.fnUntraced(function* (game: FolderGame, plugins: Plugins) {
    const code = yield* Effect.forEach(
      plugins.flatMap((plugin) => (plugin ? [plugin.name] : [])),
      (name) =>
        Effect.map(textInside(game.webRoot, `js/plugins/${name}.js`), (text) =>
          Option.match(text, {
            onNone: () => [],
            onSome: (value) => [[name, value] as const],
          }),
        ),
    );
    return new Map(code.flat());
  });

  const entries = Effect.fn("GameFolder.entries")(function* (game: FolderGame) {
    const plugins = yield* pluginList(game);
    const assets = yield* Effect.forEach(["img", "audio", "movies"], (folder) =>
      Effect.map(filesUnder(path.join(game.webRoot, folder)), (files) =>
        files.map((file) => `${folder}/${file}`),
      ),
    );
    const dataFiles = yield* Effect.forEach(game.files, (name) =>
      requiredText(game.webRoot, `data/${name}`).pipe(
        Effect.flatMap((text) => Effect.fromResult(decodeGameFile(name, text))),
        Effect.map((data) => ({ name, data })),
      ),
    );
    return gameEntries({
      plugins,
      pluginCode: yield* pluginCode(game, plugins),
      assets: assets.flat(),
      dataFiles,
    });
  });

  const contents = Effect.fn("GameFolder.contents")(function* (game: FolderGame) {
    const dataDir = path.join(game.webRoot, "data");
    const names = (yield* namesIn(dataDir)).filter((name) => name.endsWith(".json")).toSorted();
    const dataFiles = yield* Effect.forEach(names, (name) =>
      textInside(dataDir, name).pipe(
        Effect.flatMap((text) =>
          Option.match(text, {
            onNone: () => Effect.succeed([]),
            onSome: (value) =>
              Effect.map(Effect.fromResult(decodeGameFile(name, value)), (file) => [
                { name, data: file.data },
              ]),
          }),
        ),
      ),
    );
    const listed = yield* pluginList(game);
    return {
      dataFiles: dataFiles.flat(),
      plugins: listed,
      pluginCode: yield* pluginCode(game, listed),
    } satisfies GameContents;
  });

  const findTextImages = Effect.fn("GameFolder.textImages")(function* (game: FolderGame) {
    const system = yield* systemHeader(game.webRoot);
    const files = yield* filesUnder(path.join(game.webRoot, "img"));
    const maps = yield* Effect.forEach(
      game.files.filter((file) => /^Map\d+\.json$/.test(file)),
      (file) => dataFile(game, file),
    );
    const images = textImages({
      extension: imageExtension(game.engine, system.hasEncryptedImages ?? false),
      files: files.map((file) => `img/${file}`),
      maps: maps.flatMap((map) =>
        Option.isSome(map) && map.value._tag === "Map" ? [map.value.data] : [],
      ),
    });
    return { images, key: Option.fromUndefinedOr(system.encryptionKey) };
  });

  const imageEncoding = Effect.fn("GameFolder.imageEncoding")(function* (game: FolderGame) {
    const system = yield* systemHeader(game.webRoot);
    return {
      extension: imageExtension(game.engine, system.hasEncryptedImages ?? false),
      key: Option.fromUndefinedOr(system.encryptionKey),
    };
  });

  /** `relative` with each name spelled as in the folder; an exact name wins over another case. */
  const matchCase = Effect.fnUntraced(function* (root: string, relative: string) {
    let current = root;
    const found: Array<string> = [];
    for (const segment of relative.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") return Option.none<string>();
      const folder = yield* fs
        .stat(current)
        .pipe(Effect.asSome, ifMissing(current, Effect.succeedNone));
      if (Option.isNone(folder) || folder.value.type !== "Directory") return Option.none<string>();
      const exact = path.join(current, segment);
      const name = (yield* fs.exists(exact).pipe(Effect.mapError(unreadable(exact))))
        ? segment
        : (yield* namesIn(current)).find((other) => other.toLowerCase() === segment.toLowerCase());
      if (name === undefined) return Option.none<string>();
      found.push(name);
      current = path.join(current, name);
    }
    return Option.some(found.join("/"));
  });

  const find = Effect.fn("GameFolder.find")(function* (game: FolderGame, relative: string) {
    const matched = yield* matchCase(game.webRoot, relative);
    const file = Option.isSome(matched)
      ? yield* fileInside(game.webRoot, matched.value)
      : Option.none<string>();
    if (Option.isNone(file))
      return yield* new GameFileMissingError({ file: path.join(game.webRoot, relative) });
    return file.value;
  });

  const images = Effect.fn("GameFolder.images")(function* (game: FolderGame) {
    const files = yield* filesUnder(path.join(game.webRoot, "img"));
    return files.map((file) => `img/${file}`);
  });

  const present = Effect.fn("GameFolder.present")(function* (game: FolderGame) {
    return yield* isFile(path.join(game.webRoot, "data", "System.json"));
  });
  const readFile = Effect.fn("GameFolder.readFile")(function* (game: FolderGame, relative: string) {
    const file = yield* find(game, relative);
    return yield* fs.readFile(file).pipe(Effect.mapError(unreadable(file)));
  });

  return GameFolder.of({
    inspect,
    present,
    imageEncoding,
    textImages: findTextImages,
    find,
    images,
    readFile,
    entries,
    contents,
  });
});

export const layer = Layer.effect(GameFolder, make);
