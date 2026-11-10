import { useAtomSet } from "@effect/atom-react";
import type { ReadAgain } from "@rpgtl/contracts";
import { useGame } from "../games/GameContext.ts";
import { useStartRun } from "../games/startRun.ts";
import { readImages } from "./atoms.ts";

/**
 * Starts reading the game's new images with the saved settings, saving pending edits first; with
 * `again`, also those images from scratch.
 */
export function useReadImages() {
  const game = useGame();
  const start = useAtomSet(readImages, { mode: "promiseExit" });
  return useStartRun((again?: ReadAgain) =>
    start({ payload: { id: game.id, ...(again && { again }) } }),
  );
}
