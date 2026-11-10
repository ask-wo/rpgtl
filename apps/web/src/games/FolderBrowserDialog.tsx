import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { ArrowUpIcon, FolderIcon, Gamepad2Icon, HomeIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Spinner } from "~/components/ui/spinner";
import { failureMessage } from "../app/failure.ts";
import { folders } from "./atoms.ts";
import { useQuestion } from "./useQuestion.ts";

/**
 * Lets the user walk this computer's folders, starting at `start`, and choose one. A browser can't
 * tell the server the absolute path of a folder picked in its own dialog, so the server lists them.
 */
function FolderBrowserDialog({
  start,
  onChoose,
  onCancel,
}: {
  readonly start: string;
  readonly onChoose: (path: string) => void;
  readonly onCancel: () => void;
}) {
  const [path, setPath] = useState(start);
  // What the user typed into the path field; until they type, it shows the listed folder.
  const [typed, setTyped] = useState<string>();
  const [hidden, setHidden] = useState(false);
  const go = (to: string) => {
    setPath(to);
    setTyped(undefined);
  };
  const listing = useAtomValue(folders(path));
  const shown = AsyncResult.isSuccess(listing) ? listing.value : undefined;
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="flex max-h-[calc(100svh-2rem)] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose a game folder</DialogTitle>
          <DialogDescription>Folders with an MV or MZ game are marked.</DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (typed !== undefined) go(typed);
          }}
        >
          <Input
            name="path"
            aria-label="Folder"
            value={typed ?? shown?.path ?? path}
            onChange={(event) => setTyped(event.target.value)}
          />
          <Button type="submit" variant="outline">
            Go
          </Button>
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!shown?.parent}
            onClick={() => shown?.parent && go(shown.parent)}
          >
            <ArrowUpIcon />
            Up
          </Button>
          <Button size="sm" variant="outline" onClick={() => shown && go(shown.home)}>
            <HomeIcon />
            Home
          </Button>
          {shown &&
            shown.roots.length > 1 &&
            shown.roots.map((root) => (
              <Button key={root} size="sm" variant="ghost" onClick={() => go(root)}>
                {root}
              </Button>
            ))}
          <Label className="ml-auto text-xs font-normal">
            <Checkbox checked={hidden} onCheckedChange={setHidden} />
            Show hidden folders
          </Label>
        </div>
        <div className="min-h-48 flex-1 overflow-auto rounded-md border">
          {AsyncResult.isFailure(listing) ? (
            <p className="p-3 text-sm text-destructive">{failureMessage(listing.cause)}</p>
          ) : shown === undefined ? (
            <Spinner className="m-3" />
          ) : (
            <ul aria-label="Folders">
              {shown.folders
                .filter((folder) => hidden || !folder.name.startsWith("."))
                .map((folder) => (
                  <li key={folder.path}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
                      onClick={() => go(folder.path)}
                    >
                      {folder.game ? <Gamepad2Icon /> : <FolderIcon />}
                      <span className="truncate">{folder.name}</span>
                      {folder.game && <Badge variant="secondary">Game</Badge>}
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={shown === undefined} onClick={() => shown && onChoose(shown.path)}>
            Choose this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The folder browser as a question: `ask` opens it at `start`, or in the home folder, and gives the
 * chosen folder, or nothing when the user cancels. Render `dialog` where the asking component is.
 */
export function useFolderDialog(): {
  readonly ask: (start?: string) => Promise<string | undefined>;
  readonly dialog: ReactNode;
} {
  const { asked: start, ask, close } = useQuestion<string, string>();
  return {
    ask: (from) => ask(from ?? ""),
    dialog: start !== undefined && (
      <FolderBrowserDialog start={start} onChoose={close} onCancel={() => close(undefined)} />
    ),
  };
}
