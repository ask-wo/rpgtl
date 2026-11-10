import { useAtomSet } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import { useState } from "react";
import { failureMessage } from "../app/failure.ts";
import { gamesKey, inspect } from "./atoms.ts";
import { useFolderDialog } from "./FolderBrowserDialog.tsx";
import { useOtherVersionDialog } from "./OtherVersionDialog.tsx";

/**
 * Opens games: `choose` asks for a folder in the folder browser, which the caller renders as
 * `dialog`, and `open` reads the game at a folder or executable path again, keeping its saved
 * translations, and shows its overview. When the folder's game seems to be another version of a
 * saved game, `open` asks in `dialog` first whether to replace that game. `error` says why the
 * last try failed.
 */
export function useOpenGame() {
  const run = useAtomSet(inspect, { mode: "promiseExit" });
  const folderDialog = useFolderDialog();
  const versionDialog = useOtherVersionDialog();
  const navigate = useNavigate();
  const [opening, setOpening] = useState<string>();
  const [error, setError] = useState<string>();

  /** The folder chosen in the browser, which starts at `start` or in the home folder. */
  const choose = (start?: string) => {
    setError(undefined);
    return folderDialog.ask(start);
  };

  const open = async (path: string) => {
    setOpening(path);
    setError(undefined);
    let exit = await run({ payload: { path }, reactivityKeys: [gamesKey] });
    if (Exit.isSuccess(exit) && "otherVersion" in exit.value) {
      const choice = await versionDialog.ask(exit.value.otherVersion);
      if (choice === undefined) return setOpening(undefined);
      exit = await run({ payload: { path, choice }, reactivityKeys: [gamesKey] });
    }
    setOpening(undefined);
    if (Exit.isFailure(exit)) return setError(failureMessage(exit.cause));
    if ("game" in exit.value)
      await navigate({ to: "/games/$gameId", params: { gameId: exit.value.game.id } });
  };

  return {
    choose,
    dialog: (
      <>
        {folderDialog.dialog}
        {versionDialog.dialog}
      </>
    ),
    open,
    busy: opening !== undefined,
    opening,
    error,
  };
}
