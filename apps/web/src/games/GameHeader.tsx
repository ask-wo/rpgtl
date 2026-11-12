import { useAtomValue } from "@effect/atom-react";
import { engineFeatures } from "@rpgtl/domain";
import { CheckIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { PlayButtons } from "../nwjs/PlayButtons.tsx";
import { editsStatus } from "./edits.ts";
import { useGame } from "./GameContext.ts";

export function GameHeader() {
  const game = useGame();
  return (
    <header className="flex flex-wrap items-start gap-4 border-b px-6 py-3">
      <SidebarTrigger className="-ml-2 md:hidden" />
      <div className="flex h-8 min-w-0 flex-1 items-center gap-2">
        <h1 className="max-w-1/2 shrink-0 truncate text-xl font-semibold tracking-tight">
          {game.title}
        </h1>
        {game.titleTranslation && (
          <p className="min-w-0 truncate text-xl text-muted-foreground">{game.titleTranslation}</p>
        )}
        <Badge variant="secondary">{game.engine}</Badge>
        <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={game.root}>
          {[game.build?.version, game.root].filter(Boolean).join(" · ")}
        </p>
      </div>
      <SaveStatus gameId={game.id} />
      {engineFeatures[game.engine].play && <PlayButtons key={game.id} gameId={game.id} />}
    </header>
  );
}

/** Whether the edits made on the game's pages are saved. */
function SaveStatus({ gameId }: { readonly gameId: string }) {
  const { saving, error } = useAtomValue(editsStatus(gameId));
  return (
    <p
      role="status"
      className={
        error
          ? "flex min-h-8 max-w-sm items-center text-sm text-destructive"
          : "flex h-8 items-center gap-1.5 text-sm text-muted-foreground"
      }
    >
      {saving ? (
        "Saving…"
      ) : error ? (
        `Not saved: ${error}`
      ) : (
        <>
          <CheckIcon className="size-4" />
          All changes saved
        </>
      )}
    </p>
  );
}
