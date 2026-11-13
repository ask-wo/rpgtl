import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { GameLaunch, ProgramStatus } from "@rpgtl/contracts";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { ExternalLinkIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";
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
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { failureMessage } from "../app/failure.ts";
import { activity } from "../games/activity.ts";
import { megabytes } from "../translation/counts.ts";
import { download, launch, stop } from "./atoms.ts";
import { ProgramDownloading } from "./ProgramDownloading.tsx";

/**
 * Play starts the game in NW.js, downloading NW.js first once the player agrees, and turns into
 * Stop while it runs; Play in browser opens it in a new tab. Below them: the download's progress
 * and how the last start went.
 */
export function PlayButtons({ gameId }: { readonly gameId: string }) {
  const result = useAtomValue(activity(gameId));
  const now = AsyncResult.getOrElse(result, () => undefined);
  const status = now?.program;
  const lastStart = now?.launch ?? null;
  // Only a refused request ends the stream; reloading the page connects again.
  const refused = AsyncResult.isFailure(result) ? failureMessage(result.cause) : undefined;
  const start = useAtomSet(launch, { mode: "promiseExit" });
  const end = useAtomSet(stop, { mode: "promiseExit" });
  const fetchNwjs = useAtomSet(download, { mode: "promiseExit" });
  const [asking, setAsking] = useState(false);
  // The download the player agreed to, followed until it ends. The status stream can skip
  // statuses, so only a status of that same download may start the game.
  const [following, setFollowing] = useState<number>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const request = async (send: () => Promise<Exit.Exit<unknown, { readonly message: string }>>) => {
    setError(undefined);
    setPending(true);
    const exit = await send();
    setPending(false);
    if (Exit.isFailure(exit)) setError(failureMessage(exit.cause));
  };
  const play = () => request(() => start({ payload: { id: gameId } }));

  const downloadThenPlay = async () => {
    setError(undefined);
    const exit = await fetchNwjs({});
    if (Exit.isFailure(exit)) setError(failureMessage(exit.cause));
    else if (exit.value.phase._tag === "Ready") void play();
    else if (exit.value.phase._tag === "Downloading") setFollowing(exit.value.attempt);
  };

  useEffect(() => {
    if (following === undefined || status === undefined || status.attempt < following) return;
    if (status.phase._tag === "Downloading") return;
    setFollowing(undefined);
    if (status.attempt === following && status.phase._tag === "Ready") void play();
  }, [following, status]);

  const ready = status?.phase._tag === "Ready";
  const running = lastStart?.phase._tag === "Running";
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        {running ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => request(() => end({ payload: { id: gameId } }))}
          >
            {pending ? <Spinner /> : <SquareIcon />}
            Stop
          </Button>
        ) : (
          <Button
            disabled={status === undefined || status.phase._tag === "Downloading" || pending}
            onClick={() => (ready ? play() : setAsking(true))}
          >
            {pending ? <Spinner /> : <PlayIcon />}
            Play
          </Button>
        )}
        <Button
          variant="outline"
          nativeButton={false}
          render={<a href={`/game/${gameId}/`} target="_blank" rel="noreferrer" />}
        >
          Play in browser
          <ExternalLinkIcon />
        </Button>
      </div>
      {status && <DownloadProgress status={status} />}
      {(error ?? refused) && (
        <p className="max-w-md text-right text-sm wrap-anywhere text-destructive">
          {error ?? refused}
        </p>
      )}
      {lastStart && <LastStart start={lastStart} />}
      {status && (
        <AlertDialog open={asking} onOpenChange={setAsking}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Download NW.js?</AlertDialogTitle>
              <AlertDialogDescription>
                NW.js {status.version} needs a one-time download of {megabytes(status.size)} MB to{" "}
                {status.folder}. The game starts once it is done.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Not now</AlertDialogCancel>
              <AlertDialogAction onClick={downloadThenPlay}>Download and play</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

function DownloadProgress({
  status: { phase, size, version },
}: {
  readonly status: ProgramStatus;
}) {
  if (phase._tag === "Downloading")
    return (
      <ProgramDownloading
        version={version}
        received={phase.received}
        size={size}
        className="w-64 text-sm text-muted-foreground"
      />
    );
  if (phase._tag === "Missing" && phase.error)
    return (
      <p className="max-w-md text-right text-sm wrap-anywhere text-destructive">
        NW.js didn't download: {phase.error}
      </p>
    );
  return null;
}

function LastStart({ start }: { readonly start: GameLaunch }) {
  const { phase } = start;
  const failed = phase._tag === "Exited" && phase.exitCode !== 0;
  const summary =
    phase._tag === "Running"
      ? `Running in NW.js (PID ${start.pid}).`
      : phase._tag === "Stopped"
        ? "NW.js was stopped."
        : `NW.js exited with exit code ${phase.exitCode}.`;
  return (
    <details className="max-w-md text-right text-sm wrap-anywhere">
      <summary className={failed ? "text-destructive" : "text-muted-foreground"}>
        {summary} Output: {start.log}
      </summary>
      <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-left text-xs whitespace-pre-wrap">
        {start.command}
      </pre>
    </details>
  );
}
