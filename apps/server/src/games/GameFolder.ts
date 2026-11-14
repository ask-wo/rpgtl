import { createHash } from "node:crypto";
import type { Entry, Game, Plugins } from "@rpgtl/contracts";
import {
  type ArchiveEntry,
  archiveEntries,
  bootEngines,
  decodeXpFile,
  decryptEntry,
  coreScripts,
  decodeGameFile,
  decodePlugins,
  gameEntries,
  type GameContents,
  GameFileInvalid,
  type GameImage,
  imageExtension,
  mapOf,
  mediaNames,
  mediaReferences,
  mediaWarnings,
  missingFiles,
  referencedFolders,
  splitVersion,
  textImages,
  xpArchiveName,
  xpGameEntries,
  xpUnpackedArchiveName,
} from "@rpgtl/domain";
import * as Context from "effect/Context";
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

/** A path with no RPG Maker MV, MZ or XP game in it, nor an MV or MZ game in its `www` folder. */
export class NoGameFoundError extends Schema.TaggedError<NoGameFoundError>()("NoGameFoundError", {
  path: Schema.String,
}) {
  override get message() {
    return `No RPG Maker MV, MZ or XP game at ${this.path}.`;
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
    /**
     * Whether the game's folder still holds its `data/System.json`, or an XP game's archive or
     * `Data/System.rxdata`, without reading it.
     */
    readonly present: (game: FolderGame) => Effect.Effect<boolean, GameFileReadError>;
    /**
     * The extension of the game's image files and the key its encrypted images need, from its
     * `data/System.json`. RPGTL reads no images of XP games yet.
     */
    readonly imageEncoding: (
      game: FolderGame,
    ) => Effect.Effect<
      { readonly extension: string; readonly key: Option.Option<string> },
      GameFileMissingError | GameFileReadError | GameFileInvalid
    >;
    /**
     * The game's images that may hold text, and the key its encrypted images need; none for an XP
     * game yet.
     */
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
     * The `.rxdata` files of an XP game by name: from its archive, renamed by Unpack or not, else
     * from its `Data/` folder. The renamed archive counts, so files copied over the unpacked ones
     * never become the game's text.
     */
    readonly xpData: (
      game: FolderGame,
    ) => Effect.Effect<ReadonlyMap<string, Uint8Array>, GameFileReadError | GameFileInvalid>;
    /** The path of an XP game's archive, and whether Unpack renamed it; none without one. */
    readonly xpArchive: (
      game: FolderGame,
    ) => Effect.Effect<
      Option.Option<{ readonly file: string; readonly unpacked: boolean }>,
      GameFileReadError
    >;
    /** `use` given the files of the XP archive at `file` and a way to read each one's content. */
    readonly xpArchiveFiles: <A, E>(
      file: string,
      use: (
        entries: ReadonlyArray<ArchiveEntry>,
        content: (entry: ArchiveEntry) => Effect.Effect<Uint8Array, GameFileReadError>,
      ) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | GameFileReadError | GameFileInvalid>;
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

/**
 * The title in an XP game's `Game.ini`. The editor writes it in the Windows code page it ran
 * under, which the file doesn't name, so a title that isn't UTF-8 is left out.
 */
function xpTitle(ini: Uint8Array) {
  const title = /^Title=(.*)$/m.exec(new TextDecoder().decode(ini))?.[1]?.trim() ?? "";
  return title.includes("\uFFFD") ? "" : title;
}

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
    const named = splitVersion(system.gameTitle || path.basename(root));
    const version =
      splitVersion(path.basename(root)).version ??
      splitVersion(path.basename(path.dirname(root))).version ??
      named.version;
    return {
      root,
      webRoot,
      engine,
      title: named.name,
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
        ...(version !== undefined && { version }),
      },
    } satisfies FolderGame;
  });

  const findXpArchive = Effect.fnUntraced(function* (root: string) {
    for (const [name, unpacked] of [
      [xpArchiveName, false],
      [xpUnpackedArchiveName, true],
    ] as const) {
      const found = yield* matchCase(root, name);
      if (Option.isSome(found))
        return Option.some({ file: path.join(root, found.value), unpacked });
    }
    return Option.none();
  });

  const xpArchiveFiles = <A, E>(
    file: string,
    use: (
      entries: ReadonlyArray<ArchiveEntry>,
      content: (entry: ArchiveEntry) => Effect.Effect<Uint8Array, GameFileReadError>,
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(file).pipe(Effect.mapError(unreadable(file)));
        const read = (offset: number, length: number) =>
          handle
            .readAlloc(length, { position: BigInt(offset) })
            .pipe(
              Effect.map(Option.getOrElse(() => new Uint8Array())),
              Effect.mapError(unreadable(file)),
            );
        const size = Number((yield* handle.stat.pipe(Effect.mapError(unreadable(file)))).size);
        const entries = yield* archiveEntries(file, size, read);
        return yield* use(entries, (entry) =>
          Effect.map(read(entry.offset, entry.size), (bytes) => decryptEntry(entry, bytes)),
        );
      }),
    );

  /**
   * The `.rxdata` files of the XP game at `root` by name: its loose `Data/` files, replaced by those
   * its archive holds, since mkxp-z reads the archive first.
   */
  const xpDataFiles = Effect.fnUntraced(function* (root: string) {
    const files = new Map<string, Uint8Array>();
    const dataDir = yield* matchCase(root, "Data");
    if (Option.isSome(dataDir)) {
      const dir = path.join(root, dataDir.value);
      for (const name of (yield* namesIn(dir)).filter((loose) => loose.endsWith(".rxdata"))) {
        const file = path.join(dir, name);
        files.set(name, yield* fs.readFile(file).pipe(Effect.mapError(unreadable(file))));
      }
    }
    const archive = yield* findXpArchive(root);
    if (Option.isNone(archive)) return files;
    return yield* xpArchiveFiles(archive.value.file, (entries, content) =>
      Effect.gen(function* () {
        for (const entry of entries) {
          const [folder, stored] = entry.path.split("/");
          if (folder?.toLowerCase() === "data" && stored?.endsWith(".rxdata"))
            files.set(stored, yield* content(entry));
        }
        return files;
      }),
    );
  });

  /** Whether the folder holds an RPG Maker XP game: its archive or its system data. */
  const isXpGame = Effect.fnUntraced(function* (root: string) {
    if (Option.isSome(yield* findXpArchive(root))) return true;
    return Option.isSome(yield* matchCase(root, "Data/System.rxdata"));
  });

  const xpGameAt = Effect.fn("GameFolder.xpGameAt")(function* (root: string) {
    const data = yield* xpDataFiles(root);
    const files = [...data.keys()].toSorted();
    const hash = createHash("sha256");
    for (const file of files) hash.update(`${file}\0`).update(data.get(file) ?? new Uint8Array());
    const ini = yield* matchCase(root, "Game.ini");
    const iniText = Option.isSome(ini)
      ? yield* fs
          .readFile(path.join(root, ini.value))
          .pipe(Effect.mapError(unreadable(path.join(root, ini.value))))
      : new Uint8Array();
    const named = splitVersion(xpTitle(iniText) || path.basename(root));
    const version =
      splitVersion(path.basename(root)).version ??
      splitVersion(path.basename(path.dirname(root))).version ??
      named.version;
    return {
      root,
      webRoot: root,
      engine: "XP",
      title: named.name,
      files,
      encryptedAssets: Option.isSome(yield* matchCase(root, xpArchiveName)),
      mediaWarnings: [],
      missingImages: [],
      missingAudio: [],
      identity: {},
      build: { sha256: hash.digest("hex"), ...(version !== undefined && { version }) },
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
    if (yield* isXpGame(root)) return yield* xpGameAt(root);
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
    if (game.engine === "XP") {
      const data = yield* xpDataFiles(game.root);
      return xpGameEntries(
        yield* Effect.forEach(game.files, (name) =>
          Effect.flatMap(
            Effect.fromNullishOr(data.get(name)).pipe(
              Effect.mapError(
                () => new GameFileMissingError({ file: path.join(game.root, "Data", name) }),
              ),
            ),
            (bytes) => Effect.fromResult(decodeXpFile(name, bytes)),
          ),
        ),
      );
    }
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
    if (game.engine === "XP") return { images: [], key: Option.none<string>() };
    const system = yield* systemHeader(game.webRoot);
    const files = yield* filesUnder(path.join(game.webRoot, "img"));
    const maps = yield* Effect.forEach(
      game.files.filter((file) => mapOf(file) !== undefined),
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
    if (game.engine === "XP") return { extension: ".png", key: Option.none<string>() };
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
    if (game.engine === "XP") return yield* isXpGame(game.root);
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
    xpData: Effect.fn("GameFolder.xpData")(function* (game: FolderGame) {
      return yield* xpDataFiles(game.root);
    }),
    xpArchive: Effect.fn("GameFolder.xpArchive")(function* (game: FolderGame) {
      return yield* findXpArchive(game.root);
    }),
    xpArchiveFiles: Effect.fn("GameFolder.xpArchiveFiles")(function* <A, E>(
      file: string,
      use: (
        entries: ReadonlyArray<ArchiveEntry>,
        content: (entry: ArchiveEntry) => Effect.Effect<Uint8Array, GameFileReadError>,
      ) => Effect.Effect<A, E>,
    ) {
      return yield* xpArchiveFiles(file, use);
    }),
    contents,
  });
});

export const layer = Layer.effect(GameFolder, make);
