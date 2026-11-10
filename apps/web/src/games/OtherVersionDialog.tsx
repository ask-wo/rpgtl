import type { OtherVersion, VersionChoice } from "@rpgtl/contracts";
import type { ReactNode } from "react";
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
import { useQuestion } from "./useQuestion.ts";

/**
 * Asks whether the opened folder's game replaces the saved game it seems to be another version of,
 * keeping that game's translations, or is kept beside it.
 */
function OtherVersionDialog({
  other,
  onAnswer,
}: {
  readonly other: OtherVersion;
  readonly onAnswer: (choice: VersionChoice | undefined) => void;
}) {
  const { game, sure, label } = other;
  const name = other.titleTranslation ?? game.title;
  const was = game.build?.label;
  return (
    <AlertDialog open onOpenChange={(open) => !open && onAnswer(undefined)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Another version of {name}
            {!sure && "?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            RPGTL already has {name}
            {was && ` (${was})`} in {game.root}.
          </AlertDialogDescription>
          <p className="text-sm text-muted-foreground">
            <strong>Replace</strong> moves its translations to this version ({label}). Lines that
            changed lose theirs, and the old translations are backed up first.{" "}
            <strong>Keep both</strong> adds this version as a new game.
          </p>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Don't open</AlertDialogCancel>
          <Button variant="outline" onClick={() => onAnswer("keepBoth")}>
            Keep both
          </Button>
          <AlertDialogAction onClick={() => onAnswer({ replace: game.id })}>
            Replace
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** `ask` shows the question in `dialog`, which the caller renders, and gives the answer. */
export function useOtherVersionDialog(): {
  readonly ask: (other: OtherVersion) => Promise<VersionChoice | undefined>;
  readonly dialog: ReactNode;
} {
  const { asked: other, ask, close } = useQuestion<OtherVersion, VersionChoice>();
  return {
    ask,
    dialog: other && <OtherVersionDialog other={other} onAnswer={close} />,
  };
}
