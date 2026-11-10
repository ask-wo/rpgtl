import type * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";

/** How a run that exited with `exit` ended; `failure` says why one that failed did. */
export const endedPhase = (
  exit: Exit.Exit<unknown, unknown>,
  failure: (cause: Cause.Cause<unknown>) => string,
) =>
  Exit.isSuccess(exit)
    ? ({ _tag: "Finished" } as const)
    : Exit.hasInterrupts(exit)
      ? ({ _tag: "Stopped" } as const)
      : ({ _tag: "Failed", error: failure(exit.cause) } as const);
