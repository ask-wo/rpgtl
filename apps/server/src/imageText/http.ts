import {
  Api,
  GameBusy,
  GameNotInspected,
  ImageReaderBusy,
  ImageReaderRemoving,
  StateFileFailed,
} from "@rpgtl/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Option from "effect/Option";
import { stateFileFailed } from "../state/http.ts";
import * as ImageReader from "./ImageReader.ts";
import * as ImageReaderSetup from "./ImageReaderSetup.ts";
import * as ImageReading from "./ImageReading.ts";

const notInspected = () => Effect.fail(new GameNotInspected());

export const layer = HttpApiBuilder.group(
  Api,
  "images",
  Effect.fnUntraced(function* (handlers) {
    const reading = yield* ImageReading.ImageReading;
    return handlers.handleAll({
      results: Effect.fn("images.results")(function* ({ query }) {
        return yield* reading.results(query.id).pipe(
          Effect.catchTags({
            GameNotInspectedError: notInspected,
            StateFileError: stateFileFailed,
          }),
        );
      }),
      export: Effect.fn("images.export")(function* ({ query }) {
        const exported = yield* reading.exported(query.id).pipe(
          Effect.catchTags({
            GameNotInspectedError: notInspected,
            StateFileError: stateFileFailed,
          }),
        );
        return Option.getOrNull(exported);
      }),
      status: Effect.fn("images.status")(function* ({ query }) {
        const status = yield* reading
          .status(query.id)
          .pipe(Effect.catchTags({ GameNotInspectedError: notInspected }));
        return Option.getOrNull(status);
      }),
      start: Effect.fn("images.start")(function* ({ payload }) {
        return yield* reading.start(payload.id, payload.again).pipe(
          Effect.catchTags({
            GameNotInspectedError: notInspected,
            GameBusyError: () => Effect.fail(new GameBusy()),
            ReaderRemovingError: () => Effect.fail(new ImageReaderRemoving()),
            StateFileError: stateFileFailed,
          }),
        );
      }),
      stop: Effect.fn("images.stop")(function* ({ payload }) {
        const status = yield* reading
          .stop(payload.id)
          .pipe(Effect.catchTags({ GameNotInspectedError: notInspected }));
        return Option.getOrNull(status);
      }),
      clear: Effect.fn("images.clear")(function* ({ payload }) {
        return yield* reading.clear(payload.id).pipe(
          Effect.catchTags({
            GameNotInspectedError: notInspected,
            GameBusyError: () => Effect.fail(new GameBusy()),
            StateFileError: stateFileFailed,
          }),
        );
      }),
    });
  }),
);

export const readerLayer = HttpApiBuilder.group(
  Api,
  "imageReader",
  Effect.fnUntraced(function* (handlers) {
    const setup = yield* ImageReaderSetup.ImageReaderSetup;
    const reader = yield* ImageReader.ImageReader;
    const removing = (which: "reader" | "korean") =>
      reader.remove(which).pipe(
        Effect.catchTags({
          ReadingImagesError: () => Effect.fail(new ImageReaderBusy()),
          ReaderRemovingError: () => Effect.fail(new ImageReaderBusy()),
          ImageReaderRemoveError: (error) =>
            error.problem === "busy"
              ? Effect.fail(new ImageReaderBusy())
              : Effect.logError(error.message, error.cause).pipe(
                  Effect.andThen(Effect.fail(StateFileFailed.forFile(error.folder, "write"))),
                ),
        }),
      );
    return handlers.handleAll({
      status: () => Effect.succeed(setup.changes),
      setUp: Effect.fn("imageReader.setUp")(function* ({ payload }) {
        return yield* setup.setUp(payload);
      }),
      remove: () => removing("reader"),
      removeKorean: () => removing("korean"),
    });
  }),
);
