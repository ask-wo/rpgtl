import { useAtomValue } from "@effect/atom-react";
import { Link, Outlet, useMatch, useNavigate, useParams } from "@tanstack/react-router";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";
import { failureMessage } from "../app/failure.ts";
import { RunBar } from "../translation/RunBar.tsx";
import { games } from "./atoms.ts";
import { GameContext } from "./GameContext.ts";
import { GameHeader } from "./GameHeader.tsx";

/** A game's header above whichever of its pages the address names. */
export function GameLayout() {
  const { gameId } = useParams({ from: "/games/$gameId" });
  const list = useAtomValue(games);
  const onGlossary = useMatch({ from: "/games/$gameId/glossary", shouldThrow: false });
  const onImages = useMatch({ from: "/games/$gameId/images", shouldThrow: false });
  const navigate = useNavigate();
  return AsyncResult.match(list, {
    onInitial: () => <Skeleton className="m-6 h-24" />,
    onFailure: ({ cause }) => <p className="p-6 text-destructive">{failureMessage(cause)}</p>,
    onSuccess: ({ value }) => {
      const game = value.find((candidate) => candidate.id === gameId);
      if (!game)
        return (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>This game isn't in the list</EmptyTitle>
              <EmptyDescription>
                Open its folder again to bring it and its translations back.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button render={<Link to="/" />} nativeButton={false}>
                Open a game…
              </Button>
            </EmptyContent>
          </Empty>
        );
      return (
        <GameContext value={game}>
          <div className="flex h-svh flex-col">
            <GameHeader />
            <RunBar
              fits={onGlossary ? "build-glossary" : onImages ? "read-images" : "translate"}
              onShowFailed={() =>
                navigate({
                  to: "/games/$gameId/text",
                  params: { gameId },
                  search: { show: "failed" },
                })
              }
            />
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <Outlet />
            </div>
          </div>
        </GameContext>
      );
    },
  });
}
