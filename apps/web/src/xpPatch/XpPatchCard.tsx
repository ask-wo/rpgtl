import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { XpArchive } from "@rpgtl/contracts";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { type ReactNode, useState } from "react";
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
import { ButtonGroup } from "~/components/ui/button-group";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Spinner } from "~/components/ui/spinner";
import { failureMessage } from "../app/failure.ts";
import { useGame } from "../games/GameContext.ts";
import { imagesInExports } from "../images/atoms.ts";
import { IncludeImages } from "../images/IncludeImages.tsx";
import { archiveKey, pack, patchFile, unpack, xpArchive } from "./atoms.ts";

const save = (name: string, bytes: Uint8Array<ArrayBuffer>) => {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

type Action = "export" | "unpack" | "pack";

const asks = {
  unpack: {
    title: "Unpack the game's archive?",
    text: "RPGTL extracts the game's Game.rgssad and renames it to Game.rgssad.original, so patches take priority over the original game's files.",
    confirm: "Unpack",
  },
  pack: {
    title: "Undo unpacking?",
    text: "RPGTL restores the original Game.rgssad and deletes every file it created or modified.",
    confirm: "Undo unpack",
  },
} as const;

/**
 * Export patch downloads a zip of the XP game's translated data files for its own `Game.exe`;
 * Unpack archive… and Undo unpack… write or remove the archive's files in the game's folder,
 * which a patch needs when the game has an archive.
 */
export function XpPatchCard() {
  const game = useGame();
  const archive = AsyncResult.getOrElse(useAtomValue(xpArchive(game.id)), () => undefined);
  const download = useAtomSet(patchFile, { mode: "promiseExit" });
  const unpackIt = useAtomSet(unpack, { mode: "promiseExit" });
  const packIt = useAtomSet(pack, { mode: "promiseExit" });
  const [working, setWorking] = useState<Action>();
  const withImages = useAtomValue(imagesInExports);
  const [asking, setAsking] = useState<"unpack" | "pack">();
  const [result, setResult] = useState<{ readonly text: string; readonly failed: boolean }>();

  const run = async (
    action: Action,
    send: () => Promise<Exit.Exit<unknown, { readonly message: string }>>,
    done: string,
  ) => {
    setResult(undefined);
    setWorking(action);
    const exit = await send();
    setWorking(undefined);
    setResult(
      Exit.isFailure(exit)
        ? { text: failureMessage(exit.cause), failed: true }
        : { text: done, failed: false },
    );
  };

  const exportPatch = () =>
    run(
      "export",
      async () => {
        const exit = await download({ id: game.id, images: withImages });
        if (Exit.isSuccess(exit)) save(`${game.title} patch.zip`, new Uint8Array(exit.value));
        return exit;
      },
      "Exported the patch.",
    );

  const change = (action: "unpack" | "pack") => {
    setAsking(undefined);
    const send = action === "unpack" ? unpackIt : packIt;
    return run(
      action,
      () => send({ payload: { id: game.id }, reactivityKeys: archiveKey(game.id) }),
      action === "unpack" ? "Unpacked the archive." : "Put the archive back.",
    );
  };

  const label = (action: Action, idle: string, going: string) =>
    working === action ? (
      <>
        <Spinner />
        {going}
      </>
    ) : (
      idle
    );
  const ask = asking && asks[asking];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Play in Game.exe</CardTitle>
        <CardDescription>
          A patch of the translated files to copy over the game's own. Its readme says how.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <IncludeImages gameId={game.id} />
        <ButtonGroup>
          <Button variant="outline" disabled={working !== undefined} onClick={exportPatch}>
            {label("export", "Export patch", "Exporting…")}
          </Button>
          <ArchiveButton
            archive={archive}
            disabled={working !== undefined}
            onClick={setAsking}
            label={label}
          />
        </ButtonGroup>
        {result && (
          <p
            role="status"
            className={result.failed ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
          >
            {result.text}
          </p>
        )}
      </CardContent>
      <AlertDialog open={ask !== undefined} onOpenChange={(open) => !open && setAsking(undefined)}>
        {ask && asking && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{ask.title}</AlertDialogTitle>
              <AlertDialogDescription>{ask.text}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void change(asking)}>
                {ask.confirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </Card>
  );
}

function ArchiveButton({
  archive,
  disabled,
  onClick,
  label,
}: {
  readonly archive: XpArchive | undefined;
  readonly disabled: boolean;
  readonly onClick: (action: "unpack" | "pack") => void;
  readonly label: (action: Action, idle: string, going: string) => ReactNode;
}) {
  if (archive === "packed")
    return (
      <Button variant="outline" disabled={disabled} onClick={() => onClick("unpack")}>
        {label("unpack", "Unpack archive…", "Unpacking…")}
      </Button>
    );
  if (archive === "unpacked")
    return (
      <Button variant="outline" disabled={disabled} onClick={() => onClick("pack")}>
        {label("pack", "Undo unpack…", "Undoing…")}
      </Button>
    );
  return null;
}
