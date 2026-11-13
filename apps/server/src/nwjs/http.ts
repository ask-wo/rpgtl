import {
  Api,
  EngineUnsupported,
  GameBusy,
  GameNotInspected,
  LaunchFailed,
  ProgramMissing,
  GameRunning,
  StopFailed,
} from "@rpgtl/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Launches from "./Launches.ts";
import * as Nwjs from "./Nwjs.ts";

const launchFailed = (error: { readonly message: string; readonly cause: unknown }) =>
  Effect.logError(error.message, error.cause).pipe(Effect.andThen(Effect.fail(new LaunchFailed())));

export const layer = HttpApiBuilder.group(
  Api,
  "nwjs",
  Effect.fnUntraced(function* (handlers) {
    const nwjs = yield* Nwjs.Nwjs;
    const launches = yield* Launches.Launches;
    return handlers.handleAll({
      status: () => Effect.succeed(nwjs.changes),
      download: Effect.fn("nwjs.download")(function* () {
        return yield* nwjs.download;
      }),
      launch: Effect.fn("nwjs.launch")(function* ({ payload }) {
        return yield* launches.launch(payload.id).pipe(
          Effect.catchTags({
            GameNotInspectedError: () => Effect.fail(new GameNotInspected()),
            GameBusyError: () => Effect.fail(new GameBusy()),
            EngineUnsupportedError: () => Effect.fail(new EngineUnsupported()),
            ProgramMissingError: () => Effect.fail(new ProgramMissing()),
            GameRunningError: () => Effect.fail(new GameRunning()),
            LaunchError: launchFailed,
            FrontendFileError: launchFailed,
            StateFileError: launchFailed,
          }),
        );
      }),
      downloadProgram: Effect.fn("nwjs.downloadProgram")(function* ({ payload }) {
        return yield* launches.download(payload.id).pipe(
          Effect.catchTags({
            GameNotInspectedError: () => Effect.fail(new GameNotInspected()),
          }),
        );
      }),
      stop: Effect.fn("nwjs.stop")(function* ({ payload }) {
        return yield* launches.stop(payload.id).pipe(
          Effect.catchTags({
            GameNotInspectedError: () => Effect.fail(new GameNotInspected()),
            LaunchError: (error) =>
              Effect.logError(error.message, error.cause).pipe(
                Effect.andThen(Effect.fail(new StopFailed())),
              ),
          }),
        );
      }),
    });
  }),
);
