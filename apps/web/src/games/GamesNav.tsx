import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useMatch, useNavigate, useParams } from "@tanstack/react-router";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { ListedGame, QueuedRun } from "@rpgtl/contracts";
import * as Exit from "effect/Exit";
import { Gamepad2Icon, HourglassIcon, XIcon } from "lucide-react";
import { useState } from "react";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "~/components/ui/sidebar";
import { Badge } from "~/components/ui/badge";
import { Spinner } from "~/components/ui/spinner";
import { TooltipProvider } from "~/components/ui/tooltip";
import { cn } from "cn";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { failureMessage } from "../app/failure.ts";
import { TranslationNav } from "../translation/TranslationNav.tsx";
import { queuedRuns } from "./activity.ts";
import { deleteGame, forget, games, gamesKey } from "./atoms.ts";
import { croppedIcon } from "./iconCrop.ts";
import { MissingFolder } from "./MissingFolder.tsx";

/** How long the pointer rests on a game before its details show, as the browser's own tooltips wait. */
const hoverDelay = 700;

/**
 * The recent games. Clicking one shows its saved state without reading its folder again; the open
 * one's row has its translation pages under it.
 */
export function GamesNav() {
  const list = useAtomValue(games);
  const queued = AsyncResult.getOrElse(useAtomValue(queuedRuns), () => []);
  const { gameId } = useParams({ strict: false });
  const onOverview = useMatch({ from: "/games/$gameId/", shouldThrow: false }) !== undefined;
  const navigate = useNavigate();
  const remove = useAtomSet(forget, { mode: "promiseExit" });
  const erase = useAtomSet(deleteGame, { mode: "promiseExit" });
  const [removeError, setRemoveError] = useState<string>();
  const [removing, setRemoving] = useState<ListedGame>();
  const [sending, setSending] = useState(false);

  const removeGame = async (id: string, how: "forget" | "delete") => {
    setRemoveError(undefined);
    setSending(true);
    const send = how === "forget" ? remove : erase;
    const exit = await send({ payload: { id }, reactivityKeys: [gamesKey] });
    setSending(false);
    if (Exit.isFailure(exit)) return setRemoveError(failureMessage(exit.cause));
    if (id === gameId) await navigate({ to: "/" });
  };

  return (
    <TooltipProvider delay={hoverDelay}>
      <SidebarGroup>
        <SidebarGroupLabel>Games</SidebarGroupLabel>
        <SidebarMenu>
          {AsyncResult.match(list, {
            onInitial: () => <SidebarMenuSkeleton />,
            onFailure: ({ cause }) => (
              <p className="px-2 text-xs text-destructive">{failureMessage(cause)}</p>
            ),
            onSuccess: ({ value }) =>
              value.length === 0 ? (
                <p className="px-2 text-xs text-muted-foreground">Games you open show up here.</p>
              ) : (
                value.map((game) => {
                  const runs = queued.filter((run) => run.game.id === game.id);
                  const subtitle = [game.build?.version, game.titleTranslation]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <SidebarMenuItem key={game.id}>
                      <SidebarMenuButton
                        isActive={game.id === gameId && onOverview}
                        className={cn(
                          "h-auto min-h-8 md:group-has-data-[sidebar=menu-action]/menu-item:pr-2",
                          game.id === gameId && "font-medium",
                        )}
                        data-game-root={game.root}
                        tooltip={{
                          hidden: false,
                          side: "right",
                          align: "start",
                          children: <GameDetails game={game} runs={runs} />,
                        }}
                        onClick={() =>
                          navigate({ to: "/games/$gameId", params: { gameId: game.id } })
                        }
                      >
                        <GameIcon id={game.id} />
                        <span className="flex min-w-0 flex-1 flex-col whitespace-normal!">
                          <span className="flex items-center gap-2">
                            <span className="truncate">{game.title}</span>
                            <span className="ml-auto flex shrink-0 items-center gap-2">
                              <RunMark runs={runs} />
                              <Badge
                                variant="outline"
                                className="transition-none max-md:hidden md:group-focus-within/menu-item:opacity-0 md:group-hover/menu-item:opacity-0"
                              >
                                {game.engine}
                              </Badge>
                            </span>
                          </span>
                          {subtitle && (
                            <span className="line-clamp-2 text-xs font-normal text-muted-foreground">
                              {subtitle}
                            </span>
                          )}
                        </span>
                      </SidebarMenuButton>
                      <SidebarMenuAction
                        showOnHover
                        className={cn("md:right-4", subtitle ? "top-2!" : "top-4!")}
                        aria-label={`Remove ${game.title} from the list`}
                        title="Remove from the list"
                        disabled={sending}
                        onClick={() => setRemoving(game)}
                      >
                        <XIcon />
                      </SidebarMenuAction>
                      {game.id === gameId && (
                        <TranslationNav gameId={game.id} engine={game.engine} />
                      )}
                      {game.folderMissing && <MissingFolder id={game.id} root={game.root} />}
                    </SidebarMenuItem>
                  );
                })
              ),
          })}
        </SidebarMenu>
        {removeError && <p className="px-2 pt-2 text-xs text-destructive">{removeError}</p>}
        <AlertDialog
          open={removing !== undefined}
          onOpenChange={(open) => open || setRemoving(undefined)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {removing?.title ?? "the game"}?</AlertDialogTitle>
              <AlertDialogDescription>
                Removing it from the list keeps its translations, and opening it again brings them
                back. Deleting it also deletes its translations and everything else RPGTL saved for
                it. The game's own folder stays as it is.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction
                variant="outline"
                onClick={() => removing && removeGame(removing.id, "forget")}
              >
                Remove from list
              </AlertDialogAction>
              <AlertDialogAction
                variant="destructive"
                onClick={() => removing && removeGame(removing.id, "delete")}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SidebarGroup>
    </TooltipProvider>
  );
}

/**
 * What the sidebar row has no room for: the whole titles, the engine and the folder, and what
 * the game's runs do.
 */
function GameDetails({
  game,
  runs,
}: {
  readonly game: ListedGame;
  readonly runs: ReadonlyArray<QueuedRun>;
}) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium">{game.title}</span>
      {game.titleTranslation && <span>{game.titleTranslation}</span>}
      <span className="wrap-anywhere opacity-70">
        {game.engine} · {game.root}
      </span>
      {runs.map((run) => (
        <span key={run.kind}>{runSummary(run)}</span>
      ))}
    </span>
  );
}

const list = new Intl.ListFormat("en", { type: "conjunction" });

/** What a run does, or what it waits for, in a few words. */
const runSummary = ({ kind, game, waitingFor }: QueuedRun) => {
  if (waitingFor.length === 0) return kind === "translation" ? "Translating" : "Reading images";
  const named = waitingFor.map(({ kind: other, game: theirs }) => {
    const run = other === "translation" ? "translation" : "image reading";
    return theirs.id === game.id ? `this game's ${run}` : `${run} in ${theirs.title}`;
  });
  return `${kind === "translation" ? "Translation" : "Image reading"} waits for ${list.format(named)}`;
};

/** A spinner while one of the game's runs goes, or an hourglass while they only wait. */
function RunMark({ runs }: { readonly runs: ReadonlyArray<QueuedRun> }) {
  const going = runs.find((run) => run.waitingFor.length === 0);
  const shown = going ?? runs[0];
  if (shown === undefined) return null;
  const label = runSummary(shown);
  return going ? (
    <Spinner aria-label={label} className="size-3.5 shrink-0 text-muted-foreground" />
  ) : (
    <HourglassIcon
      role="img"
      aria-label={label}
      className="size-3.5 shrink-0 text-muted-foreground"
    />
  );
}

/**
 * The game's own icon cut to its visible pixels, or a gamepad when it has none or its folder is
 * gone. The file shows only once it is cut, so a padded icon doesn't flash at its smaller size.
 */
function GameIcon({ id }: { readonly id: string }) {
  const file = `/game/${id}/icon/icon.png`;
  const [shown, setShown] = useState<{ readonly src: string; readonly cut: boolean } | "missing">({
    src: file,
    cut: false,
  });
  if (shown === "missing")
    return (
      <span className="flex size-9 shrink-0 items-center justify-center">
        <Gamepad2Icon />
      </span>
    );
  return (
    <img
      src={shown.src}
      alt=""
      className={cn("size-9 shrink-0 rounded-sm object-contain", !shown.cut && "invisible")}
      onLoad={(event) => {
        if (!shown.cut) setShown({ src: croppedIcon(event.currentTarget) ?? file, cut: true });
      }}
      onError={() => setShown("missing")}
    />
  );
}
