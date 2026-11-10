import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { FolderOpenIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { games } from "./atoms.ts";
import { useOpenGame } from "./useOpenGame.tsx";

/**
 * Opens the game in the folder the user chooses in the folder browser, which starts in the folder
 * holding the open game, where other games often are.
 */
export function OpenGameButton() {
  const { gameId } = useParams({ strict: false });
  const list = AsyncResult.getOrElse(useAtomValue(games), () => []);
  const { choose, dialog, open, busy, error } = useOpenGame();
  const openRoot = list.find((game) => game.id === gameId)?.root;

  const chooseAndOpen = async () => {
    const chosen = await choose(openRoot && `${openRoot}/..`);
    if (chosen !== undefined) await open(chosen);
  };

  return (
    <>
      <Button variant="outline" disabled={busy} onClick={chooseAndOpen}>
        {busy ? <Spinner /> : <FolderOpenIcon />}
        Open a game…
      </Button>
      {error && <p className="px-2 text-xs text-destructive">{error}</p>}
      {dialog}
    </>
  );
}
