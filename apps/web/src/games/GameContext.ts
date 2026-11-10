import type { ListedGame } from "@rpgtl/contracts";
import { createContext, use } from "react";

/** The game the address names, for the pages below its header. */
export const GameContext = createContext<ListedGame | undefined>(undefined);

export const useGame = () => {
  const game = use(GameContext);
  if (!game) throw new Error("useGame needs a GameContext above it.");
  return game;
};
