import type {
  Catalog,
  CatalogChange,
  ExportedImageText,
  Findings,
  Game,
  GameSettings,
  ImportPreview,
  ImportProgress,
  ListedGame,
  OperationKind,
  OtherVersion,
  RunModels,
  SourceLanguage,
  TermEdit,
  TranslationFile,
  VersionChoice,
} from "@rpgtl/contracts";
import {
  catalogChange,
  catalogFindings,
  type CheckedCatalog,
  type DraftChanges,
  type EntryEdit,
  type EntryEditInvalid,
  type GameFileInvalid,
  type GlossaryTermRepeated,
  type ImageOptions,
  imageEntries,
  imageLimits,
  importedImageText,
  importPreview,
  importTranslations,
  inspectedEntries,
  type ReadEntry,
  restoredCatalog,
  sameGame,
  type TranslationFileInvalid,
  withEntryEdits,
  withGlossary,
  withImageEntries,
  withImageOptions,
  withTermLinesCleared,
  withTermTranslationsCleared,
  withTranslationsCleared,
} from "@rpgtl/domain";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { importedImageFiles, importedImageResults } from "../imageText/exportedImages.ts";
import * as ImageTexts from "../imageText/ImageTexts.ts";
import type * as StateFolder from "../state/StateFolder.ts";
import {
  readCatalog,
  readTitleTranslation,
  startOperation,
  writeChanged,
  writeInspected,
  writeOperation,
  writeRunChanges,
} from "./catalogRows.ts";
import * as GameDatabases from "./GameDatabases.ts";
import * as GameFolder from "./GameFolder.ts";
import * as Games from "./Games.ts";

/** A folder that isn't the game it should be moved to, as too little of its text matches. */
export class NotSameGameError extends Schema.TaggedError<NotSameGameError>()("NotSameGameError", {
  path: Schema.String,
  title: Schema.String,
}) {
  override get message() {
    return `The game at ${this.path} isn't ${this.title}.`;
  }
}

/** A folder another saved game is in, listed or removed, which a moved game can't take over. */
export class GameFolderTakenError extends Schema.TaggedError<GameFolderTakenError>()(
  "GameFolderTakenError",
  { path: Schema.String },
) {
  override get message() {
    return `RPGTL already keeps translations for the game at ${this.path}.`;
  }
}

/** Each inspected game's catalog, kept in its database (`GameDatabases`). */
export class Catalogs extends Context.Service<
  Catalogs,
  {
    readonly get: (id: string) => Effect.Effect<Catalog, Games.GameNotInspectedError>;
    /** What the translation checks find in the game's catalog, by check. */
    readonly checks: (id: string) => Effect.Effect<Findings, Games.GameNotInspectedError>;
    /** The game's catalog with what the checks find in it, then each change written to it. */
    readonly changes: (
      id: string,
    ) => Effect.Effect<Stream.Stream<CatalogChange>, Games.GameNotInspectedError>;
    /**
     * Writes what `f` makes of the saved catalog under a new operation of `kind`, unless it gives
     * the catalog unchanged, and gives what it made. The caller holds the game.
     */
    readonly update: <A extends { readonly catalog: Catalog }, E>(
      id: string,
      kind: OperationKind,
      f: (catalog: Catalog) => Result.Result<A, E>,
    ) => Effect.Effect<A, E | Games.GameNotInspectedError>;
    /** Starts a translation run's operation and gives its id. */
    readonly startRun: (id: string, models: RunModels) => Effect.Effect<number>;
    /** Writes the texts and terms a run changed under its operation. */
    readonly writeRun: (
      id: string,
      operationId: number,
      changes: DraftChanges,
    ) => Effect.Effect<void>;
    /** The listed games, each with the English of its title, and whether its folder is gone. */
    readonly list: Effect.Effect<ReadonlyArray<ListedGame>>;
    /** How many characters each image entry of the game has room for, by entry id. */
    readonly imageLimits: (
      id: string,
    ) => Effect.Effect<ReadonlyMap<string, number>, StateFolder.StateFileError>;
    /**
     * Lists the game at `path` and reads its text and image read results into its catalog,
     * keeping the saved translations and settings. While another operation holds a listed game,
     * such as a run, gives the saved game and catalog instead. A game opened before in this
     * folder, also one removed from the list since, keeps its id. A game new to the folder that
     * seems to be another version of a saved game gives that game instead, until `choice` says
     * whether to replace it, which keeps its translations of the lines that didn't change.
     */
    readonly inspect: (
      path: string,
      choice?: VersionChoice,
    ) => Effect.Effect<
      { readonly game: Game; readonly catalog: Catalog } | { readonly otherVersion: OtherVersion },
      | Games.GameNotInspectedError
      | GameFolder.GamePathEmptyError
      | GameFolder.NoGameFoundError
      | GameFolder.GameFileMissingError
      | GameFolder.GameFileReadError
      | GameFileInvalid
      | Games.GameBusyError
      | StateFolder.StateFileError
    >;
    /**
     * Points the listed game `id` at the folder at `path`, where the game moved: it keeps its id,
     * state and place in the list, and its catalog is read again from the new folder. Fails when
     * the folder's text doesn't match the game's, or when another saved game, listed or removed,
     * is in that folder.
     */
    readonly move: (
      id: string,
      path: string,
    ) => Effect.Effect<
      { readonly game: Game; readonly catalog: Catalog },
      | Games.GameNotInspectedError
      | GameFolder.GamePathEmptyError
      | GameFolder.NoGameFoundError
      | GameFolder.GameFileMissingError
      | GameFolder.GameFileReadError
      | GameFileInvalid
      | NotSameGameError
      | GameFolderTakenError
      | Games.GameBusyError
      | StateFolder.StateFileError
    >;
    /**
     * Takes the translations and settings of a translation file, and replaces the read results
     * and erased backgrounds of the images whose image text it carries.
     */
    readonly import: (
      id: string,
      file: TranslationFile,
    ) => Effect.Effect<
      Catalog,
      | Games.GameNotInspectedError
      | Games.GameBusyError
      | TranslationFileInvalid
      | StateFolder.StateFileError
    >;
    /** What `import` would change, without saving anything. */
    readonly previewImport: (
      id: string,
      file: TranslationFile,
    ) => Effect.Effect<
      ImportPreview,
      Games.GameNotInspectedError | TranslationFileInvalid | StateFolder.StateFileError
    >;
    /** How far the game's import goes now and after each change, none while none goes. */
    readonly importChanges: (
      id: string,
    ) => Effect.Effect<Stream.Stream<Option.Option<ImportProgress>>, Games.GameNotInspectedError>;
    /**
     * Turns the game's translation switch on or off, holding the game while it does; the game
     * plays with it from its next load.
     */
    readonly setTranslate: (
      id: string,
      on: boolean,
    ) => Effect.Effect<Catalog, Games.GameNotInspectedError | Games.GameBusyError>;
    /**
     * Turns the XP game's fix named `name` on or off, holding the game while it does; the game
     * plays with it from its next start.
     */
    readonly setFix: (
      id: string,
      name: string,
      on: boolean,
    ) => Effect.Effect<Catalog, Games.GameNotInspectedError | Games.GameBusyError>;
    /**
     * Sets whether an XP game plays with its scripts translated, holding the game while it does;
     * the game plays with it from its next start.
     */
    readonly setScriptTranslation: (
      id: string,
      on: boolean,
    ) => Effect.Effect<Catalog, Games.GameNotInspectedError | Games.GameBusyError>;
    /**
     * Sets the language of the game's text, holding the game while it does; null goes back to the
     * one its text looks like.
     */
    readonly setLanguage: (
      id: string,
      language: SourceLanguage | null,
    ) => Effect.Effect<Catalog, Games.GameNotInspectedError | Games.GameBusyError>;
    /**
     * Saves the glossary the user edited, holding the game while it does; a text that is exactly
     * a term whose English changed follows it.
     */
    readonly setGlossary: (
      id: string,
      glossary: ReadonlyArray<TermEdit>,
    ) => Effect.Effect<
      void,
      Games.GameNotInspectedError | Games.GameBusyError | GlossaryTermRepeated
    >;
    /** Saves the English and entry choices the user edited, holding the game while it does. */
    readonly setEntries: (
      id: string,
      edits: ReadonlyArray<EntryEdit>,
    ) => Effect.Effect<void, Games.GameNotInspectedError | Games.GameBusyError | EntryEditInvalid>;
    /** Saves the user's image choices, holding the game while it does. */
    readonly setImageOptions: (
      id: string,
      options: ImageOptions,
    ) => Effect.Effect<void, Games.GameNotInspectedError | Games.GameBusyError>;
    /**
     * Clears the translations that contain one of the terms with these sources, or with
     * `mismatchesOnly` only those that don't use its English; gives how many it cleared.
     */
    readonly clearTermLines: (
      id: string,
      sources: ReadonlyArray<string>,
      mismatchesOnly: boolean,
    ) => Effect.Effect<number, Games.GameNotInspectedError | Games.GameBusyError>;
    /**
     * Clears the English that runs gave these terms and the texts that are one or contain one,
     * keeping the English the user typed; gives how many of each it cleared.
     */
    readonly clearTermTranslations: (
      id: string,
      sources: ReadonlyArray<string>,
    ) => Effect.Effect<
      { readonly terms: number; readonly texts: number },
      Games.GameNotInspectedError | Games.GameBusyError
    >;
    /**
     * Clears the English that runs gave the texts of these entries, keeping the English the user
     * typed; gives how many texts it cleared.
     */
    readonly clearTranslations: (
      id: string,
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<number, Games.GameNotInspectedError | Games.GameBusyError>;
    /** Clears every translation and rejected answer, holding the game while it does. */
    readonly restore: (
      id: string,
    ) => Effect.Effect<Catalog, Games.GameNotInspectedError | Games.GameBusyError>;
  }
>()("@rpgtl/server/games/Catalogs") {}

const imageTextOf = (file: TranslationFile): ExportedImageText | undefined =>
  file.images && { images: file.images, ...(file.imageRuns && { runs: file.imageRuns }) };

/** `made`, or the catalog unchanged when nothing was cleared, so nothing is written. */
const unchangedUnless = <A extends { readonly catalog: Catalog }>(
  before: Catalog,
  made: A,
  changed: boolean,
): A => (changed ? made : { ...made, catalog: before });

const make = Effect.gen(function* () {
  const games = yield* Games.Games;
  const gameFolder = yield* GameFolder.GameFolder;
  const imageTexts = yield* ImageTexts.ImageTexts;
  const databases = yield* GameDatabases.GameDatabases;

  // The app's own tables failing is no request's fault, so it is a defect.
  const inDatabase = <A, E, R>(id: string, effect: Effect.Effect<A, E | SqlError.SqlError, R>) =>
    databases
      .use(id, effect)
      .pipe(Effect.catchIf(SqlError.isSqlError, (error) => Effect.die(error)));

  const read = Effect.fn("Catalogs.read")(function* (game: Game) {
    return yield* inDatabase(
      game.id,
      readCatalog({ id: game.id, title: game.title, engine: game.engine }),
    );
  });
  const get = Effect.fn("Catalogs.get")(function* (id: string) {
    const catalog = yield* read(yield* games.get(id));
    if (catalog === undefined) return yield* new Games.GameNotInspectedError({ id });
    return catalog;
  });

  // The last catalog written of each game a page follows, and how many follow it, so a write
  // checks only the entries it changed: the checks over a game of 20,000 entries take a third of a
  // second. The last follower to leave drops it, so the next one reads the database again, in case
  // a command-line tool changed it.
  const followed = yield* Ref.make(
    new Map<string, { readonly checked: CheckedCatalog; readonly followers: number }>(),
  );
  const written = yield* PubSub.unbounded<{
    readonly id: string;
    readonly change: CatalogChange;
  }>();
  // Every change to `followed` holds this, and a follower subscribes while holding it, so no
  // write comes between reading the catalog and subscribing.
  const following = yield* Semaphore.make(1);
  const follow = (id: string) =>
    Effect.acquireRelease(
      following.withPermits(1)(
        Effect.gen(function* () {
          const known = (yield* Ref.get(followed)).get(id);
          // `changes` has just read the catalog and answered its errors, so one here is unexpected.
          const checked =
            known?.checked ?? catalogChange(undefined, yield* Effect.orDie(get(id))).checked;
          yield* Ref.update(followed, (all) =>
            new Map(all).set(id, { checked, followers: (known?.followers ?? 0) + 1 }),
          );
          return { checked, subscription: yield* PubSub.subscribe(written) };
        }),
      ),
      () => unfollow(id),
    );
  const unfollow = (id: string) =>
    following.withPermits(1)(
      Ref.update(followed, (all) => {
        const known = all.get(id);
        if (known === undefined) return all;
        const next = new Map(all);
        if (known.followers > 1) next.set(id, { ...known, followers: known.followers - 1 });
        else next.delete(id);
        return next;
      }),
    );
  /** Sends what changed to the game's followers, reading the catalog only when one follows it. */
  const publish = (game: Game, saved?: Catalog) =>
    following.withPermits(1)(
      Effect.gen(function* () {
        const known = (yield* Ref.get(followed)).get(game.id);
        if (known === undefined) return;
        const catalog = saved ?? (yield* read(game));
        if (catalog === undefined) return;
        const { checked, change } = catalogChange(known.checked, catalog);
        yield* Ref.update(followed, (all) => new Map(all).set(game.id, { ...known, checked }));
        yield* PubSub.publish(written, { id: game.id, change });
      }),
    );
  const checks = Effect.fn("Catalogs.checks")(function* (id: string) {
    const known = (yield* Ref.get(followed)).get(id);
    return known ? known.checked.findings : catalogFindings(yield* get(id));
  });
  const changes = Effect.fn("Catalogs.changes")(function* (id: string) {
    // Reads the catalog once here, so a game that isn't inspected answers with its error.
    yield* get(id);
    return Stream.unwrap(
      Effect.map(follow(id), ({ checked, subscription }) =>
        Stream.concat(
          Stream.succeed<CatalogChange>({ _tag: "whole", ...checked }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((write) => write.id === id),
            Stream.map((write) => write.change),
          ),
        ),
      ),
    );
  });

  /**
   * Writes what `next` changes from `before` under a new operation of `kind`, and gives the
   * catalog as saved, with the ids the database gave new texts and terms.
   */
  const write = Effect.fn("Catalogs.write")(function* (
    game: Game,
    kind: OperationKind,
    before: Catalog,
    next: Catalog,
  ) {
    // A stop between writing and publishing would leave the game's followers a write behind.
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* inDatabase(
          game.id,
          writeOperation(kind, (operationId) => writeChanged(before, next, operationId)),
        );
        const saved = yield* read(game);
        if (saved === undefined) return yield* new Games.GameNotInspectedError({ id: game.id });
        yield* publish(game, saved);
        return saved;
      }),
    );
  });

  const update = Effect.fn("Catalogs.update")(function* <
    A extends { readonly catalog: Catalog },
    E,
  >(id: string, kind: OperationKind, f: (catalog: Catalog) => Result.Result<A, E>) {
    const game = yield* games.get(id);
    const before = yield* get(id);
    const made = yield* Effect.fromResult(f(before));
    if (made.catalog === before) return made;
    return { ...made, catalog: yield* write(game, kind, before, made.catalog) };
  });

  const startRun = Effect.fn("Catalogs.startRun")(function* (id: string, models: RunModels) {
    return yield* inDatabase(id, startOperation("run", models));
  });
  const writeRun = Effect.fn("Catalogs.writeRun")(function* (
    id: string,
    operationId: number,
    changed: DraftChanges,
  ) {
    // The caller holds the game, so it stays listed.
    const game = yield* Effect.orDie(games.get(id));
    yield* Effect.uninterruptible(
      Effect.andThen(
        inDatabase(
          id,
          Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql.withTransaction(writeRunChanges(changed, operationId)),
          ),
        ),
        publish(game),
      ),
    );
  });

  const title = Effect.fn("Catalogs.titleTranslation")(function* (id: string) {
    return Option.fromUndefinedOr(yield* inDatabase(id, readTitleTranslation()));
  });
  const list = Effect.fn("Catalogs.list")(function* () {
    return yield* Effect.forEach(
      yield* games.list,
      Effect.fnUntraced(function* (game) {
        const translated = yield* title(game.id);
        const present = yield* gameFolder.present(game).pipe(
          Effect.catchTags({
            GameFileReadError: (error) =>
              Effect.logWarning("Couldn't look into a game's folder", error).pipe(Effect.as(true)),
          }),
        );
        return {
          ...game,
          ...Option.match(translated, {
            onNone: () => ({}),
            onSome: (english) => ({ titleTranslation: english }),
          }),
          ...(!present && { folderMissing: true as const }),
        } satisfies ListedGame;
      }),
      { concurrency: 4 },
    );
  });
  const limits = Effect.fn("Catalogs.imageLimits")(function* (id: string) {
    return imageLimits(yield* imageTexts.results(id));
  });

  const rebuild = Effect.fn("Catalogs.rebuild")(function* (
    game: Game,
    entries: ReadonlyArray<ReadEntry>,
  ) {
    const results = yield* imageTexts.results(game.id);
    const previous = yield* read(game);
    const inspected = inspectedEntries([...entries, ...imageEntries(results)], previous);
    yield* Effect.uninterruptible(
      Effect.andThen(
        inDatabase(
          game.id,
          writeOperation("inspection", (operationId) => writeInspected(inspected, operationId)),
        ),
        games.save(game),
      ),
    );
    const catalog = yield* read(game);
    if (catalog === undefined) return yield* new Games.GameNotInspectedError({ id: game.id });
    yield* publish(game, catalog);
    return { game, catalog };
  });
  /** The saved game and catalog of a listed game another operation holds, or `busy`. */
  const whileHeld = Effect.fn("Catalogs.whileHeld")(function* (
    id: string,
    busy: Games.GameBusyError,
  ) {
    const game = yield* games
      .get(id)
      .pipe(Effect.catchTags({ GameNotInspectedError: () => Effect.fail(busy) }));
    const catalog = yield* read(game);
    if (catalog === undefined) return yield* busy;
    return { game, catalog };
  });
  /** The id of a game RPGTL didn't open in its folder before, or the saved game to ask about. */
  const newGameId = Effect.fn("Catalogs.newGameId")(function* (
    found: GameFolder.FolderGame,
    choice: VersionChoice | undefined,
  ) {
    const others = yield* games.otherVersions(found);
    if (choice === undefined && others[0]) {
      const english = yield* title(others[0].game.id);
      return {
        otherVersion: {
          ...others[0],
          ...(found.build?.version !== undefined && { version: found.build.version }),
          ...(Option.isSome(english) && { titleTranslation: english.value }),
        },
      };
    }
    if (choice === undefined || choice === "keepBoth") return { id: yield* games.newId };
    if (!others.some((other) => other.game.id === choice.replace))
      return yield* new Games.GameNotInspectedError({ id: choice.replace });
    return { id: choice.replace };
  });
  const inspect = Effect.fn("Catalogs.inspect")(function* (given: string, choice?: VersionChoice) {
    const found = yield* gameFolder.inspect(given);
    const known = yield* games.idAt(found.webRoot);
    const chosen = Option.isSome(known) ? { id: known.value } : yield* newGameId(found, choice);
    if ("otherVersion" in chosen) return { otherVersion: chosen.otherVersion };
    const game: Game = { ...found, id: chosen.id };
    const rebuilt = games.exclusive(
      game.id,
      Effect.flatMap(gameFolder.entries(game), (entries) => rebuild(game, entries)),
    );
    // The saved game is in another folder when it is being replaced, so it can't stand in.
    if (Option.isNone(known)) return yield* rebuilt;
    return yield* rebuilt.pipe(
      Effect.catchTags({ GameBusyError: (busy) => whileHeld(game.id, busy) }),
    );
  });

  const move = Effect.fn("Catalogs.move")(function* (id: string, given: string) {
    const listed = yield* games.get(id);
    const found = yield* gameFolder.inspect(given);
    const owner = yield* games.idAt(found.webRoot);
    if (Option.isSome(owner) && owner.value !== id)
      return yield* new GameFolderTakenError({ path: found.root });
    const game: Game = { ...found, id };
    return yield* games.exclusive(
      id,
      Effect.gen(function* () {
        const entries = yield* gameFolder.entries(game);
        if (!sameGame(yield* get(id), entries))
          return yield* new NotSameGameError({ path: found.root, title: listed.title });
        return yield* rebuild(game, entries);
      }),
    );
  });

  const imports = yield* SubscriptionRef.make(new Map<string, ImportProgress>());
  const setProgress = (id: string, progress: ImportProgress | undefined) =>
    SubscriptionRef.update(imports, (all) => {
      const next = new Map(all);
      if (progress) next.set(id, progress);
      else next.delete(id);
      return next;
    });
  const importChanges = Effect.fn("Catalogs.importChanges")(function* (id: string) {
    yield* games.get(id);
    return SubscriptionRef.changes(imports).pipe(
      Stream.map((all) => all.get(id)),
      Stream.changesWith((a, b) => a === b),
      Stream.map(Option.fromUndefinedOr),
    );
  });

  const previewImport = Effect.fn("Catalogs.previewImport")(function* (
    id: string,
    file: TranslationFile,
  ) {
    const current = yield* get(id);
    const savedImages = yield* imageTexts.results(id);
    const imageText = imageTextOf(file);
    let withImages: Catalog = current;
    if (imageText) {
      const results = yield* importedImageResults(yield* games.get(id), imageText).pipe(
        Effect.provideService(GameFolder.GameFolder, gameFolder),
      );
      withImages = withImageEntries(
        current,
        importedImageText(savedImages, { results, erased: new Map() }).results,
        savedImages,
      );
    }
    const next = yield* Effect.fromResult(importTranslations(withImages, file));
    return importPreview(current, next, savedImages, file);
  });

  const importFile = Effect.fn("Catalogs.import")(function* (id: string, file: TranslationFile) {
    return yield* games.exclusive(
      id,
      Effect.gen(function* () {
        const game = yield* games.get(id);
        const current = yield* get(id);
        const imageText = imageTextOf(file);
        if (!imageText) {
          const next = yield* Effect.fromResult(importTranslations(current, file));
          return yield* write(game, "import", current, next);
        }
        const total = Object.keys(imageText.images).length;
        const rebuilt = yield* importedImageFiles(game, imageText, (done) =>
          setProgress(id, { done, total }),
        ).pipe(
          Effect.provideService(GameFolder.GameFolder, gameFolder),
          Effect.ensuring(setProgress(id, undefined)),
        );
        const savedImages = yield* imageTexts.results(id);
        const imported = importedImageText(savedImages, rebuilt);
        const next = yield* Effect.fromResult(
          importTranslations(withImageEntries(current, imported.results, savedImages), file),
        );
        return yield* Effect.uninterruptible(
          Effect.andThen(imageTexts.replace(id, imported), write(game, "import", current, next)),
        );
      }),
    );
  });

  /** Writes what `f` makes of the game's settings while holding the game. */
  const editSettings = (id: string, f: (settings: GameSettings) => GameSettings) =>
    games.edit(
      id,
      Effect.gen(function* () {
        const game = yield* games.get(id);
        const before = yield* get(id);
        return yield* write(game, "edit", before, { ...before, settings: f(before.settings) });
      }),
    );
  const setTranslate = Effect.fn("Catalogs.setTranslate")(function* (id: string, on: boolean) {
    return yield* editSettings(id, (settings) => ({ ...settings, isTranslationOn: on }));
  });
  const setScriptTranslation = Effect.fn("Catalogs.setScriptTranslation")(function* (
    id: string,
    on: boolean,
  ) {
    return yield* editSettings(id, (settings) => ({ ...settings, isScriptTranslationOn: on }));
  });
  const setFix = Effect.fn("Catalogs.setFix")(function* (id: string, name: string, on: boolean) {
    return yield* editSettings(id, (settings) => {
      const off = settings.disabledFixes.filter((other) => other !== name);
      return { ...settings, disabledFixes: on ? off : [...off, name] };
    });
  });
  const setLanguage = Effect.fn("Catalogs.setLanguage")(function* (
    id: string,
    language: SourceLanguage | null,
  ) {
    return yield* editSettings(id, (settings) => ({
      ...Struct.omit(settings, ["sourceLanguage"]),
      ...(language && { sourceLanguage: language }),
    }));
  });

  /** Writes what `f` makes of the catalog under an operation of `kind` while holding the game. */
  const edit = <A extends { readonly catalog: Catalog }, E>(
    id: string,
    kind: OperationKind,
    f: (catalog: Catalog) => Result.Result<A, E>,
  ) => games.edit(id, update(id, kind, f));
  const cleared = <A extends { readonly catalog: Catalog }>(
    id: string,
    f: (catalog: Catalog) => A,
  ) =>
    games.exclusive(
      id,
      update(id, "clear", (catalog) => Result.succeed(f(catalog))),
    );

  const setGlossary = Effect.fn("Catalogs.setGlossary")(function* (
    id: string,
    glossary: ReadonlyArray<TermEdit>,
  ) {
    yield* edit(id, "edit", (catalog) =>
      Result.map(withGlossary(catalog, glossary), (next) => ({ catalog: next })),
    );
  });
  const setEntries = Effect.fn("Catalogs.setEntries")(function* (
    id: string,
    edits: ReadonlyArray<EntryEdit>,
  ) {
    yield* edit(id, "edit", (catalog) =>
      Result.map(withEntryEdits(catalog, edits), (next) => ({ catalog: next })),
    );
  });
  const setImageOptions = Effect.fn("Catalogs.setImageOptions")(function* (
    id: string,
    options: ImageOptions,
  ) {
    yield* edit(id, "edit", (catalog) =>
      Result.succeed({ catalog: withImageOptions(catalog, options) }),
    );
  });

  const clearTermLines = Effect.fn("Catalogs.clearTermLines")(function* (
    id: string,
    sources: ReadonlyArray<string>,
    mismatchesOnly: boolean,
  ) {
    const made = yield* cleared(id, (catalog) => {
      const result = withTermLinesCleared(catalog, sources, mismatchesOnly);
      return unchangedUnless(catalog, result, result.cleared > 0);
    });
    return made.cleared;
  });
  const clearTermTranslations = Effect.fn("Catalogs.clearTermTranslations")(function* (
    id: string,
    sources: ReadonlyArray<string>,
  ) {
    const made = yield* cleared(id, (catalog) => {
      const result = withTermTranslationsCleared(catalog, sources);
      return unchangedUnless(catalog, result, result.terms + result.texts > 0);
    });
    return { terms: made.terms, texts: made.texts };
  });
  const clearTranslations = Effect.fn("Catalogs.clearTranslations")(function* (
    id: string,
    ids: ReadonlyArray<string>,
  ) {
    const made = yield* cleared(id, (catalog) => {
      const result = withTranslationsCleared(catalog, ids);
      return unchangedUnless(catalog, result, result.cleared > 0);
    });
    return made.cleared;
  });
  const restore = Effect.fn("Catalogs.restore")(function* (id: string) {
    const made = yield* cleared(id, (catalog) => ({ catalog: restoredCatalog(catalog) }));
    return made.catalog;
  });

  return Catalogs.of({
    get,
    checks,
    changes,
    update,
    startRun,
    writeRun,
    list: list(),
    imageLimits: limits,
    inspect,
    move,
    import: importFile,
    previewImport,
    importChanges,
    setTranslate,
    setFix,
    setScriptTranslation,
    setLanguage,
    setGlossary,
    setEntries,
    setImageOptions,
    clearTermLines,
    clearTermTranslations,
    clearTranslations,
    restore,
  });
});

export const layer = Layer.effect(Catalogs, make);
