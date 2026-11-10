import * as Exit from "effect/Exit";
import { useState } from "react";
import { failureMessage } from "../app/failure.ts";
import { useGameEdits } from "./edits.ts";
import { useGame } from "./GameContext.ts";

/** Starts a run on the open game with `start`, saving its pending edits first. */
export function useStartRun<A extends ReadonlyArray<unknown>>(
  start: (...input: A) => Promise<Exit.Exit<unknown, { readonly message: string }>>,
) {
  const game = useGame();
  const edits = useGameEdits(game.id);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (...input: A) => {
    setError(undefined);
    setStarting(true);
    const unsaved = await edits.flush();
    if (unsaved) {
      setStarting(false);
      return setError(unsaved);
    }
    const exit = await start(...input);
    setStarting(false);
    if (Exit.isFailure(exit)) setError(failureMessage(exit.cause));
  };

  return { run, starting, error, setError };
}
