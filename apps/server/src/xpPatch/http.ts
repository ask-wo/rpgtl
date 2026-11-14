import {
  Api,
  ArchiveChanged,
  CloseGameFirst,
  EngineUnsupported,
  GameBusy,
  GameFileFailed,
  GameFolderWriteFailed,
  GameNotInspected,
} from "@rpgtl/contracts";
import type { GameFileInvalid } from "@rpgtl/domain";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import type * as GameFolder from "../games/GameFolder.ts";
import { stateFileFailed } from "../state/http.ts";
import * as XpFixes from "./XpFixes.ts";
import * as XpPatch from "./XpPatch.ts";

const archiveFailed = {
  GameNotInspectedError: () => Effect.fail(new GameNotInspected()),
  EngineUnsupportedError: () => Effect.fail(new EngineUnsupported()),
  GameFileReadError: (error: GameFolder.GameFileReadError) =>
    Effect.logError(error.message, error.cause).pipe(
      Effect.andThen(Effect.fail(GameFileFailed.unreadable(error.file))),
    ),
} as const;

const fixesFailed = {
  GameNotInspectedError: () => Effect.fail(new GameNotInspected()),
  EngineUnsupportedError: () => Effect.fail(new EngineUnsupported()),
  StateFileError: stateFileFailed,
} as const;

const readFailed = {
  ...archiveFailed,
  GameFileInvalid: (error: GameFileInvalid) =>
    Effect.fail(GameFileFailed.invalid(error.file, error.problem)),
} as const;

const changeFailed = {
  ...readFailed,
  GameBusyError: () => Effect.fail(new GameBusy()),
  GameStillRunningError: () => Effect.fail(new CloseGameFirst()),
  ArchiveChangedError: () => Effect.fail(new ArchiveChanged()),
  GameFolderWriteError: (error: XpPatch.GameFolderWriteError) =>
    Effect.logError(error.message, error.cause).pipe(
      Effect.andThen(Effect.fail(new GameFolderWriteFailed())),
    ),
} as const;

export const layer = HttpApiBuilder.group(
  Api,
  "xpPatch",
  Effect.fnUntraced(function* (handlers) {
    const patches = yield* XpPatch.XpPatch;
    const fixes = yield* XpFixes.XpFixes;
    return handlers.handleAll({
      patch: Effect.fn("xpPatch.patch")(function* ({ query }) {
        return yield* patches.zip(query.id, { images: query.images !== "none" }).pipe(
          Effect.catchTags({
            ...readFailed,
            StateFileError: stateFileFailed,
            GameDataChanged: (error) =>
              Effect.fail(
                GameFileFailed.invalid(
                  error.file,
                  "its text isn't what RPGTL read from the game. Open the game again.",
                ),
              ),
          }),
        );
      }),
      archive: Effect.fn("xpPatch.archive")(function* ({ query }) {
        return yield* patches.archive(query.id).pipe(Effect.catchTags(archiveFailed));
      }),
      unpack: Effect.fn("xpPatch.unpack")(function* ({ payload }) {
        return yield* patches.unpack(payload.id).pipe(Effect.catchTags(changeFailed));
      }),
      fixes: Effect.fn("xpPatch.fixes")(function* ({ query }) {
        return yield* fixes.list(query.id).pipe(Effect.catchTags(fixesFailed));
      }),
      setFix: Effect.fn("xpPatch.setFix")(function* ({ payload }) {
        return yield* fixes.set(payload.id, payload.name, payload.on).pipe(
          Effect.catchTags({
            ...fixesFailed,
            GameBusyError: () => Effect.fail(new GameBusy()),
          }),
        );
      }),
      pack: Effect.fn("xpPatch.pack")(function* ({ payload }) {
        return yield* patches.pack(payload.id).pipe(Effect.catchTags(changeFailed));
      }),
    });
  }),
);
