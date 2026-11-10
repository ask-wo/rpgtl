import { StateFileFailed } from "@rpgtl/contracts";
import * as Effect from "effect/Effect";
import type * as StateFolder from "./StateFolder.ts";

/** The API's error for a state file, logging why the file failed. */
export const stateFileFailed = (error: StateFolder.StateFileError) =>
  Effect.logError(error.message, error.cause).pipe(
    Effect.andThen(Effect.fail(StateFileFailed.forFile(error.file, error.operation))),
  );
