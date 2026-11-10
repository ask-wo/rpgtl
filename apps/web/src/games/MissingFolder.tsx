import { useAtomRefresh, useAtomSet } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { failureMessage } from "../app/failure.ts";
import { games, gamesKey, move } from "./atoms.ts";
import { useFolderDialog } from "./FolderBrowserDialog.tsx";

/**
 * Under a listed game whose folder is gone: looks for it again, or moves the game to the folder the
 * user chooses, keeping its translations.
 */
export function MissingFolder({ id, root }: { readonly id: string; readonly root: string }) {
  const lookAgain = useAtomRefresh(games);
  const folderDialog = useFolderDialog();
  const run = useAtomSet(move, { mode: "promiseExit" });
  const navigate = useNavigate();
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string>();

  const choose = async () => {
    setError(undefined);
    const picked = await folderDialog.ask(root);
    if (picked === undefined) return;
    setMoving(true);
    const exit = await run({
      payload: { id, path: picked },
      reactivityKeys: [gamesKey],
    });
    setMoving(false);
    if (Exit.isFailure(exit)) return setError(failureMessage(exit.cause));
    await navigate({ to: "/games/$gameId", params: { gameId: exit.value.game.id } });
  };

  return (
    <div role="alert" className="flex flex-col gap-2 px-2 py-2 text-xs">
      <p className="text-destructive">
        No game at {root} any more. Moved it? Choose its new folder.
      </p>
      <div className="flex gap-2">
        <Button size="xs" variant="outline" disabled={moving} onClick={choose}>
          {moving && <Spinner />}
          Choose its new folder…
        </Button>
        <Button size="xs" variant="ghost" disabled={moving} onClick={lookAgain}>
          Try again
        </Button>
      </div>
      {error && <p className="text-destructive">{error}</p>}
      {folderDialog.dialog}
    </div>
  );
}
