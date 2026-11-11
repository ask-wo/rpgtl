import {
  Api,
  FolderUnreadable,
  GameBusy,
  GameFileFailed,
  GameFolderTaken,
  GameNotInspected,
  GamePathMissing,
  EntryRejected,
  GlossaryRejected,
  NoGameFound,
  NotSameGame,
  TranslationFileRejected,
} from "@rpgtl/contracts";
import { decodeTranslationFile, type GameFileInvalid } from "@rpgtl/domain";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Playtime from "../play/Playtime.ts";
import { stateFileFailed } from "../state/http.ts";
import * as Catalogs from "./Catalogs.ts";
import * as FolderBrowser from "./FolderBrowser.ts";
import type * as GameFolder from "./GameFolder.ts";
import * as Games from "./Games.ts";

const notInspected = () => Effect.fail(new GameNotInspected());
const busy = () => Effect.fail(new GameBusy());
const readFailed = {
  GameNotInspectedError: notInspected,
  StateFileError: stateFileFailed,
} as const;
const writeFailed = { ...readFailed, GameBusyError: busy } as const;

/** What reading a game folder fails with, as the page shows it. */
const folderFailed = {
  GamePathEmptyError: () => Effect.fail(new GamePathMissing()),
  NoGameFoundError: () => Effect.fail(new NoGameFound()),
  GameFileMissingError: (error: GameFolder.GameFileMissingError) =>
    Effect.fail(GameFileFailed.missing(error.file)),
  GameFileReadError: (error: GameFolder.GameFileReadError) =>
    Effect.logError(error.message, error.cause).pipe(
      Effect.andThen(Effect.fail(GameFileFailed.unreadable(error.file))),
    ),
  GameFileInvalid: (error: GameFileInvalid) =>
    Effect.fail(GameFileFailed.invalid(error.file, error.problem)),
  GameBusyError: busy,
  StateFileError: stateFileFailed,
} as const;

const GamesHandlers = HttpApiBuilder.group(
  Api,
  "games",
  Effect.fnUntraced(function* (handlers) {
    const games = yield* Games.Games;
    const catalogs = yield* Catalogs.Catalogs;
    const folders = yield* FolderBrowser.FolderBrowser;
    const playtime = yield* Playtime.Playtime;
    return handlers.handleAll({
      list: Effect.fn("games.list")(function* () {
        return yield* catalogs.list;
      }),
      inspect: Effect.fn("games.inspect")(function* ({ payload }) {
        return yield* catalogs
          .inspect(payload.path, payload.choice)
          .pipe(Effect.catchTags({ ...folderFailed, GameNotInspectedError: notInspected }));
      }),
      move: Effect.fn("games.move")(function* ({ payload }) {
        return yield* catalogs.move(payload.id, payload.path).pipe(
          Effect.catchTags({
            ...folderFailed,
            GameNotInspectedError: notInspected,
            NotSameGameError: (error) => Effect.fail(NotSameGame.at(error.path, error.title)),
            GameFolderTakenError: (error) => Effect.fail(GameFolderTaken.at(error.path)),
          }),
        );
      }),
      folders: Effect.fn("games.folders")(function* ({ query }) {
        return yield* folders.list(query.path ?? "").pipe(
          Effect.catchTags({
            FolderUnreadableError: (error) =>
              Effect.logWarning(error.message, error.cause).pipe(
                Effect.andThen(Effect.fail(FolderUnreadable.at(error.path))),
              ),
          }),
        );
      }),
      playtime: Effect.fn("games.playtime")(function* ({ query }) {
        return yield* playtime
          .get(query.id)
          .pipe(Effect.map(Option.getOrNull), Effect.catchTags(readFailed));
      }),
      forget: Effect.fn("games.forget")(function* ({ payload }) {
        return yield* games.forget(payload.id).pipe(Effect.catchTags(writeFailed));
      }),
    });
  }),
);

const CatalogsHandlers = HttpApiBuilder.group(
  Api,
  "catalogs",
  Effect.fnUntraced(function* (handlers) {
    const catalogs = yield* Catalogs.Catalogs;
    return handlers.handleAll({
      get: Effect.fn("catalogs.get")(function* ({ query }) {
        return yield* catalogs.get(query.id).pipe(Effect.catchTags(readFailed));
      }),
      checks: Effect.fn("catalogs.checks")(function* ({ query }) {
        return yield* catalogs.checks(query.id).pipe(Effect.catchTags(readFailed));
      }),
      changes: Effect.fn("catalogs.changes")(function* ({ query }) {
        return yield* catalogs.changes(query.id).pipe(Effect.catchTags(readFailed));
      }),
      previewImport: Effect.fn("catalogs.previewImport")(function* ({ payload }) {
        return yield* Effect.fromResult(decodeTranslationFile(payload.catalog)).pipe(
          Effect.flatMap((file) => catalogs.previewImport(payload.id, file)),
          Effect.catchTags({
            GameNotInspectedError: notInspected,
            TranslationFileInvalid: (error) =>
              Effect.fail(TranslationFileRejected.because(error.problem, error.detail)),
            StateFileError: stateFileFailed,
          }),
        );
      }),
      import: Effect.fn("catalogs.import")(function* ({ payload }) {
        // HttpApi answers a payload it can't decode with an empty 400, so the file is decoded here
        // to tell the page which field doesn't fit.
        return yield* Effect.fromResult(decodeTranslationFile(payload.catalog)).pipe(
          Effect.flatMap((file) => catalogs.import(payload.id, file)),
          Effect.catchTags({
            GameNotInspectedError: notInspected,
            GameBusyError: busy,
            TranslationFileInvalid: (error) =>
              Effect.fail(TranslationFileRejected.because(error.problem, error.detail)),
            StateFileError: stateFileFailed,
          }),
        );
      }),
      setTranslate: Effect.fn("catalogs.setTranslate")(function* ({ payload }) {
        return yield* catalogs
          .setTranslate(payload.id, payload.on)
          .pipe(Effect.catchTags(writeFailed));
      }),
      setLanguage: Effect.fn("catalogs.setLanguage")(function* ({ payload }) {
        return yield* catalogs
          .setLanguage(payload.id, payload.language)
          .pipe(Effect.catchTags(writeFailed));
      }),
      setGlossary: Effect.fn("catalogs.setGlossary")(function* ({ payload }) {
        return yield* catalogs.setGlossary(payload.id, payload.glossary).pipe(
          Effect.catchTags({
            GameNotInspectedError: notInspected,
            GameBusyError: busy,
            GlossaryTermRepeated: (error) => Effect.fail(GlossaryRejected.repeated(error.source)),
            StateFileError: stateFileFailed,
          }),
        );
      }),
      setEntries: Effect.fn("catalogs.setEntries")(function* ({ payload }) {
        return yield* catalogs.setEntries(payload.id, payload.entries).pipe(
          Effect.catchTags({
            GameNotInspectedError: notInspected,
            GameBusyError: busy,
            EntryEditInvalid: (error) =>
              Effect.fail(EntryRejected.because(error.id, error.problem)),
            StateFileError: stateFileFailed,
          }),
        );
      }),
      setImageOptions: Effect.fn("catalogs.setImageOptions")(function* ({ payload }) {
        const { id, ...options } = payload;
        return yield* catalogs.setImageOptions(id, options).pipe(Effect.catchTags(writeFailed));
      }),
      clearTermLines: Effect.fn("catalogs.clearTermLines")(function* ({ payload }) {
        const cleared = yield* catalogs
          .clearTermLines(payload.id, payload.sources, payload.mismatchesOnly)
          .pipe(Effect.catchTags(writeFailed));
        return { cleared };
      }),
      restore: Effect.fn("catalogs.restore")(function* ({ payload }) {
        return yield* catalogs.restore(payload.id).pipe(Effect.catchTags(writeFailed));
      }),
    });
  }),
);

export const layer = Layer.mergeAll(GamesHandlers, CatalogsHandlers);
