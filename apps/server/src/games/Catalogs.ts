import {
  Catalog,
  type CatalogChange,
  type Entry,
  type ExportedImageText,
  type Findings,
  type Game,
  type GlossaryTerm,
  type TermEdit,
  type ImportPreview,
  type OtherVersion,
  type SourceLanguage,
  type VersionChoice,
  type ImportProgress,
  type ListedGame,
  type TranslationFile,
  gameFiles,
} from "@rpgtl/contracts";
import {
  catalogChange,
  catalogFindings,
  type CheckedCatalog,
  type EntryEdit,
  type EntryEditInvalid,
  type GameFileInvalid,
  type GlossaryTermRepeated,
  type ImageOptions,
  type NamedTerm,
  importedImageText,
  importPreview,
  importTranslations,
  imageEntries,
  imageLimits,
  inspectedCatalog,
  restoredCatalog,
  sameGame,
  titleTranslation,
  type TranslationFileInvalid,
  withEntryEdits,
  withGlossary,
  withImageOptions,
  withImageEntries,
  withTermLinesCleared,
} from "@rpgtl/domain";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { importedImageFiles, importedImageResults } from "../imageText/exportedImages.ts";
import * as ImageTexts from "../imageText/ImageTexts.ts";
import * as StateFolder from "../state/StateFolder.ts";
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

/** Each inspected game's catalog, `games/<game id>/catalog.json` in the state folder. */
export class Catalogs extends Context.Service<
  Catalogs,
  {
    readonly get: (
      id: string,
    ) => Effect.Effect<Catalog, Games.GameNotInspectedError | StateFolder.StateFileError>;
    /** What the translation checks find in the game's catalog, by check. */
    readonly checks: (
      id: string,
    ) => Effect.Effect<Findings, Games.GameNotInspectedError | StateFolder.StateFileError>;
    /** The game's catalog with what the checks find in it, then each change written to it. */
    readonly changes: (
      id: string,
    ) => Effect.Effect<
      Stream.Stream<CatalogChange>,
      Games.GameNotInspectedError | StateFolder.StateFileError
    >;
    /** Backs up the saved catalog before writing the new one. */
    readonly save: (catalog: Catalog) => Effect.Effect<void, StateFolder.StateFileError>;
    /** Writes the catalog without a backup, as a run does after each batch. */
    readonly write: (catalog: Catalog) => Effect.Effect<void, StateFolder.StateFileError>;
    /**
     * The listed games, each with the English of its title in its saved catalog, kept in memory
     * after the first read so listing doesn't read every catalog each time, and whether its folder
     * is gone.
     */
    readonly list: Effect.Effect<ReadonlyArray<ListedGame>>;
    /** How many characters each image entry of the game has room for, by entry id. */
    readonly imageLimits: (
      id: string,
    ) => Effect.Effect<ReadonlyMap<string, number>, StateFolder.StateFileError>;
    /**
     * Lists the game at `path` and rebuilds its catalog from the game's text and image read
     * results, keeping the saved translations and settings. While another operation holds a
     * listed game, such as a run, gives the saved game and catalog instead. A game opened before
     * in this folder, also one removed from the list since, keeps its id. A game new to the folder
     * that seems to be another version of a saved game gives that game instead, until `choice`
     * says whether to replace it, which keeps its translations of the lines that didn't change.
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
     * state and place in the list, and its catalog is rebuilt from the new folder. Fails when the
     * folder's text doesn't match the game's, or when another saved game, listed or removed, is in
     * that folder.
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
    ) => Effect.Effect<
      Catalog,
      Games.GameNotInspectedError | Games.GameBusyError | StateFolder.StateFileError
    >;
    /**
     * Turns the XP game's fix named `name` on or off, holding the game while it does; the game
     * plays with it from its next start.
     */
    readonly setFix: (
      id: string,
      name: string,
      on: boolean,
    ) => Effect.Effect<
      Catalog,
      Games.GameNotInspectedError | Games.GameBusyError | StateFolder.StateFileError
    >;
    /**
     * Sets whether an XP game plays with its scripts unchanged, holding the game while it does;
     * the game plays with it from its next start.
     */
    readonly setOriginalScripts: (
      id: string,
      on: boolean,
    ) => Effect.Effect<
      Catalog,
      Games.GameNotInspectedError | Games.GameBusyError | StateFolder.StateFileError
    >;
    /**
     * Sets the language of the game's text, holding the game while it does; null goes back to the
     * one its text looks like.
     */
    readonly setLanguage: (
      id: string,
      language: SourceLanguage | null,
    ) => Effect.Effect<
      Catalog,
      Games.GameNotInspectedError | Games.GameBusyError | StateFolder.StateFileError
    >;
    /**
     * Saves the glossary the user edited without a backup, holding the game while it does; an
     * entry that is exactly a term whose English changed follows it.
     */
    readonly setGlossary: (
      id: string,
      glossary: ReadonlyArray<TermEdit>,
    ) => Effect.Effect<
      void,
      | Games.GameNotInspectedError
      | Games.GameBusyError
      | GlossaryTermRepeated
      | StateFolder.StateFileError
    >;
    /** Saves the English the user edited without a backup, holding the game while it does. */
    readonly setEntries: (
      id: string,
      edits: ReadonlyArray<EntryEdit>,
    ) => Effect.Effect<
      void,
      | Games.GameNotInspectedError
      | Games.GameBusyError
      | EntryEditInvalid
      | StateFolder.StateFileError
    >;
    /** Saves the user's image choices without a backup, holding the game while it does. */
    readonly setImageOptions: (
      id: string,
      options: ImageOptions,
    ) => Effect.Effect<
      void,
      Games.GameNotInspectedError | Games.GameBusyError | StateFolder.StateFileError
    >;
    /**
     * Clears the translations that contain one of the terms with these sources, or with
     * `mismatchesOnly` only those that don't use its English, backing up first; gives how many it
     * cleared.
     */
    readonly clearTermLines: (
      id: string,
      sources: ReadonlyArray<string>,
      mismatchesOnly: boolean,
    ) => Effect.Effect<
      number,
      Games.GameNotInspectedError | Games.GameBusyError | StateFolder.StateFileError
    >;
    /** Clears every translation and what runs left, holding the game while it does. */
    readonly restore: (
      id: string,
    ) => Effect.Effect<
      Catalog,
      Games.GameNotInspectedError | Games.GameBusyError | StateFolder.StateFileError
    >;
    /**
     * Adds the names whose source the glossary lacks as terms of guessed English and kind, holding
     * the game while it does; gives the terms it added.
     */
    readonly addTerms: (
      id: string,
      terms: ReadonlyArray<NamedTerm>,
    ) => Effect.Effect<
      ReadonlyArray<GlossaryTerm>,
      Games.GameNotInspectedError | Games.GameBusyError | StateFolder.StateFileError
    >;
  }
>()("@rpgtl/server/games/Catalogs") {}

const imageTextOf = (file: TranslationFile): ExportedImageText | undefined =>
  file.images && { images: file.images, ...(file.imageRuns && { runs: file.imageRuns }) };

const make = Effect.gen(function* () {
  const folder = yield* StateFolder.StateFolder;
  const games = yield* Games.Games;
  const gameFolder = yield* GameFolder.GameFolder;
  const imageTexts = yield* ImageTexts.ImageTexts;

  const get = Effect.fn("Catalogs.get")(function* (id: string) {
    yield* games.get(id);
    const saved = yield* folder.read(gameFiles(id).catalog, Catalog);
    if (Option.isNone(saved)) return yield* new Games.GameNotInspectedError({ id });
    return saved.value;
  });
  // The last catalog written of each game a page follows, and how many follow it, so a write
  // checks only the entries it changed: the checks over a game of 20,000 entries take a third of a
  // second. The last follower to leave drops it, so the next one reads the file again, in case a
  // command-line tool changed it.
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
          // `changes` has just read the file and answered its errors, so one here is unexpected.
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
  const publish = (catalog: Catalog) =>
    following.withPermits(1)(
      Effect.gen(function* () {
        const id = catalog.game.id;
        const known = (yield* Ref.get(followed)).get(id);
        if (known === undefined) return;
        const { checked, change } = catalogChange(known.checked, catalog);
        yield* Ref.update(followed, (all) => new Map(all).set(id, { ...known, checked }));
        yield* PubSub.publish(written, { id, change });
      }),
    );
  const checks = Effect.fn("Catalogs.checks")(function* (id: string) {
    yield* games.get(id);
    const known = (yield* Ref.get(followed)).get(id);
    return known ? known.checked.findings : catalogFindings(yield* get(id));
  });
  const changes = Effect.fn("Catalogs.changes")(function* (id: string) {
    // Reads the file once here, so a game or catalog that can't be read answers with its error.
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
  const titles = yield* Ref.make(new Map<string, string | undefined>());
  const keepTitle = (catalog: Catalog) =>
    Ref.update(titles, (known) => new Map(known).set(catalog.game.id, titleTranslation(catalog)));
  const title = Effect.fn("Catalogs.titleTranslation")(function* (id: string) {
    const known = yield* Ref.get(titles);
    if (known.has(id)) return Option.fromUndefinedOr(known.get(id));
    const saved = yield* folder.read(gameFiles(id).catalog, Catalog);
    const read = Option.getOrUndefined(Option.map(saved, titleTranslation));
    // A save while the catalog was read already put the newer title in.
    return yield* Ref.modify(titles, (now) =>
      now.has(id)
        ? [Option.fromUndefinedOr(now.get(id)), now]
        : [Option.fromUndefinedOr(read), new Map(now).set(id, read)],
    );
  });
  const list = Effect.fn("Catalogs.list")(function* () {
    return yield* Effect.forEach(
      yield* games.list,
      Effect.fnUntraced(function* (game) {
        const translated = yield* title(game.id).pipe(
          Effect.catchTags({
            StateFileError: (error) =>
              Effect.logWarning("Couldn't read a game's title translation", error).pipe(
                Effect.as(Option.none<string>()),
              ),
          }),
        );
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
  // A stop between writing the file and publishing it would leave its followers a write behind.
  const writeAndPublish = (catalog: Catalog) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        yield* folder.write(gameFiles(catalog.game.id).catalog, Catalog, catalog);
        yield* keepTitle(catalog);
        yield* publish(catalog);
      }),
    );
  const save = Effect.fn("Catalogs.save")(function* (catalog: Catalog) {
    yield* folder.backUp(gameFiles(catalog.game.id).catalog);
    yield* writeAndPublish(catalog);
  });
  const write = Effect.fn("Catalogs.write")(function* (catalog: Catalog) {
    yield* writeAndPublish(catalog);
  });
  const limits = Effect.fn("Catalogs.imageLimits")(function* (id: string) {
    return imageLimits(yield* imageTexts.results(id));
  });

  const rebuild = Effect.fn("Catalogs.rebuild")(function* (
    game: Game,
    entries: ReadonlyArray<Entry>,
  ) {
    const results = yield* imageTexts.results(game.id);
    const previous = yield* folder.read(gameFiles(game.id).catalog, Catalog);
    const catalog = inspectedCatalog(
      game,
      [...entries, ...imageEntries(results)],
      Option.getOrUndefined(previous),
    );
    yield* Effect.uninterruptible(Effect.andThen(save(catalog), games.save(game)));
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
    const catalog = yield* folder.read(gameFiles(id).catalog, Catalog);
    if (Option.isNone(catalog)) return yield* busy;
    return { game, catalog: catalog.value };
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
      Effect.flatMap(gameFolder.entries(game), (read) => rebuild(game, read)),
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
        const read = yield* gameFolder.entries(game);
        if (!sameGame(yield* get(id), read))
          return yield* new NotSameGameError({ path: found.root, title: listed.title });
        return yield* rebuild(game, read);
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
    let withImages = current;
    if (imageText) {
      const results = yield* importedImageResults(yield* games.get(id), imageText).pipe(
        Effect.provideService(GameFolder.GameFolder, gameFolder),
      );
      withImages = withImageEntries(
        current,
        importedImageText(savedImages, { results, erased: new Map() }).results,
      );
    }
    const next = yield* Effect.fromResult(importTranslations(withImages, file));
    return importPreview(current, next, savedImages, file);
  });

  const importFile = Effect.fn("Catalogs.import")(function* (id: string, file: TranslationFile) {
    return yield* games.exclusive(
      id,
      Effect.gen(function* () {
        const current = yield* get(id);
        const imageText = imageTextOf(file);
        if (!imageText) {
          const next = yield* Effect.fromResult(importTranslations(current, file));
          yield* save(next);
          return next;
        }
        const total = Object.keys(imageText.images).length;
        const rebuilt = yield* importedImageFiles(yield* games.get(id), imageText, (done) =>
          setProgress(id, { done, total }),
        ).pipe(
          Effect.provideService(GameFolder.GameFolder, gameFolder),
          Effect.ensuring(setProgress(id, undefined)),
        );
        const imported = importedImageText(yield* imageTexts.results(id), rebuilt);
        const next = yield* Effect.fromResult(
          importTranslations(withImageEntries(current, imported.results), file),
        );
        yield* Effect.uninterruptible(Effect.andThen(imageTexts.replace(id, imported), save(next)));
        return next;
      }),
    );
  });

  const setTranslate = Effect.fn("Catalogs.setTranslate")(function* (id: string, on: boolean) {
    return yield* games.exclusive(
      id,
      get(id).pipe(
        Effect.map((catalog): Catalog => ({ ...catalog, translate: on })),
        Effect.tap(write),
      ),
    );
  });

  const setOriginalScripts = Effect.fn("Catalogs.setOriginalScripts")(function* (
    id: string,
    on: boolean,
  ) {
    return yield* games.exclusive(
      id,
      get(id).pipe(
        Effect.map(({ originalScripts: _old, ...catalog }): Catalog => ({
          ...catalog,
          ...(on && { originalScripts: true }),
        })),
        Effect.tap(write),
      ),
    );
  });

  const setFix = Effect.fn("Catalogs.setFix")(function* (id: string, name: string, on: boolean) {
    return yield* games.exclusive(
      id,
      get(id).pipe(
        Effect.map(({ disabledFixes = [], ...catalog }): Catalog => {
          const off = disabledFixes.filter((other) => other !== name);
          if (!on) off.push(name);
          return { ...catalog, ...(off.length > 0 && { disabledFixes: off }) };
        }),
        Effect.tap(write),
      ),
    );
  });

  const setLanguage = Effect.fn("Catalogs.setLanguage")(function* (
    id: string,
    language: SourceLanguage | null,
  ) {
    return yield* games.exclusive(
      id,
      get(id).pipe(
        Effect.map(({ language: _old, ...catalog }): Catalog => ({
          ...catalog,
          ...(language && { language }),
        })),
        Effect.tap(write),
      ),
    );
  });

  const setGlossary = Effect.fn("Catalogs.setGlossary")(function* (
    id: string,
    glossary: ReadonlyArray<TermEdit>,
  ) {
    yield* games.exclusive(
      id,
      Effect.gen(function* () {
        yield* write(yield* Effect.fromResult(withGlossary(yield* get(id), glossary)));
      }),
    );
  });

  const setEntries = Effect.fn("Catalogs.setEntries")(function* (
    id: string,
    edits: ReadonlyArray<EntryEdit>,
  ) {
    yield* games.exclusive(
      id,
      Effect.gen(function* () {
        yield* write(yield* Effect.fromResult(withEntryEdits(yield* get(id), edits)));
      }),
    );
  });

  const setImageOptions = Effect.fn("Catalogs.setImageOptions")(function* (
    id: string,
    options: ImageOptions,
  ) {
    yield* games.exclusive(
      id,
      get(id).pipe(
        Effect.map((catalog) => withImageOptions(catalog, options)),
        Effect.flatMap(write),
      ),
    );
  });

  const clearTermLines = Effect.fn("Catalogs.clearTermLines")(function* (
    id: string,
    sources: ReadonlyArray<string>,
    mismatchesOnly: boolean,
  ) {
    return yield* games.exclusive(
      id,
      Effect.gen(function* () {
        const { catalog, cleared } = withTermLinesCleared(yield* get(id), sources, mismatchesOnly);
        if (cleared > 0) yield* save(catalog);
        return cleared;
      }),
    );
  });

  const restore = Effect.fn("Catalogs.restore")(function* (id: string) {
    return yield* games.exclusive(id, get(id).pipe(Effect.map(restoredCatalog), Effect.tap(save)));
  });

  const addTerms = Effect.fn("Catalogs.addTerms")(function* (
    id: string,
    names: ReadonlyArray<NamedTerm>,
  ) {
    return yield* games.exclusive(
      id,
      Effect.gen(function* () {
        const catalog = yield* get(id);
        const known = new Set(catalog.glossary.map((term) => term.source));
        const added = names
          .filter((name) => !known.has(name.source))
          .map(({ source, translation, kind }): GlossaryTerm => ({
            source,
            translation: { guess: { value: translation } },
            kind: { guess: { value: kind } },
          }));
        if (added.length) yield* save({ ...catalog, glossary: [...catalog.glossary, ...added] });
        return added;
      }),
    );
  });

  return Catalogs.of({
    addTerms,
    get,
    checks,
    changes,
    save,
    write,
    list: list(),
    imageLimits: limits,
    inspect,
    move,
    import: importFile,
    previewImport,
    importChanges,
    setTranslate,
    setOriginalScripts,
    setFix,
    setLanguage,
    setGlossary,
    setEntries,
    setImageOptions,
    clearTermLines,
    restore,
  });
});

export const layer = Layer.effect(Catalogs, make);
