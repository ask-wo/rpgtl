import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ImportPreview } from "@rpgtl/contracts";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useRef, useState } from "react";
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
import { Spinner } from "~/components/ui/spinner";
import { failureMessage } from "../app/failure.ts";
import { activity } from "../games/activity.ts";
import {
  catalogKey,
  clearAll,
  imageResultsKey,
  importFile,
  previewImport,
  translationFile,
} from "./atoms.ts";

const download = (name: string, value: unknown) => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

const changes = (parts: ReadonlyArray<[number, string]>) => {
  const listed = parts.filter(([count]) => count > 0).map(([count, what]) => `${count} ${what}`);
  return listed.length ? listed.join(", ") : "nothing changes";
};

/** What an import would change, a line for each part of the file. */
function previewLines({ translations, glossary, images }: ImportPreview) {
  return [
    `${plural(translations.inFile, "translation")}: ${changes([
      [translations.added, "new"],
      [translations.changed, "changed"],
      [translations.cleared, "cleared"],
    ])}.`,
    ...(translations.notInGame
      ? [
          translations.notInGame === 1
            ? "1 is for a line this game doesn't have and will be skipped."
            : `${translations.notInGame.toLocaleString()} are for lines this game doesn't have and will be skipped.`,
        ]
      : []),
    ...(glossary.inFile || glossary.removed
      ? [
          `${plural(glossary.inFile, "glossary term")}, in place of the saved glossary: ${changes([
            [glossary.added, "new"],
            [glossary.changed, "changed"],
            [glossary.removed, "removed"],
          ])}.`,
        ]
      : []),
    ...(images.inFile
      ? [
          `${plural(images.inFile, "image")} with English, ${images.replaced} of them in place of images already read.`,
        ]
      : []),
  ];
}

type Action = "export" | "preview" | "import" | "clear";

/**
 * Export, Import… and Clear all…, which back up the saved translations before changing them and
 * wait while a run goes. Import first shows what the file would change.
 */
export function TranslationActions(props: TranslationActionsProps) {
  // Keyed by the game, so a preview that answers after another game opened can't open its
  // dialog there and import into that game.
  return <GameTranslationActions key={props.gameId} {...props} />;
}

interface TranslationActionsProps {
  readonly gameId: string;
  readonly locked: boolean;
}

function GameTranslationActions({ gameId, locked }: TranslationActionsProps) {
  const exportFile = useAtomSet(translationFile, { mode: "promiseExit" });
  const preview = useAtomSet(previewImport, { mode: "promiseExit" });
  const importIt = useAtomSet(importFile, { mode: "promiseExit" });
  const clear = useAtomSet(clearAll, { mode: "promiseExit" });
  const importing = AsyncResult.getOrElse(
    useAtomValue(activity(gameId)),
    () => undefined,
  )?.importing;
  const picker = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState<Action>();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState<{
    readonly name: string;
    readonly catalog: unknown;
    readonly preview: ImportPreview;
  }>();
  const [result, setResult] = useState<{ readonly text: string; readonly failed: boolean }>();
  if (locked && (asking || pending)) {
    setAsking(false);
    setPending(undefined);
  }

  const run = async <A,>(
    action: Action,
    work: () => Promise<Exit.Exit<A, { readonly message: string }>>,
    done: string | ((value: A) => void),
  ) => {
    setResult(undefined);
    setWorking(action);
    try {
      const exit = await work();
      if (Exit.isFailure(exit)) setResult({ text: failureMessage(exit.cause), failed: true });
      else if (typeof done === "string") setResult({ text: done, failed: false });
      else done(exit.value);
    } catch (error) {
      setResult({ text: String(error), failed: true });
    } finally {
      setWorking(undefined);
    }
  };

  const exportTranslations = () =>
    run(
      "export",
      async () => {
        const exit = await exportFile(gameId);
        if (Exit.isSuccess(exit)) download(`${gameId}-translations.json`, exit.value);
        return exit;
      },
      "Exported the saved translations.",
    );

  const previewTranslations = async (file: File) => {
    let catalog: unknown;
    try {
      catalog = JSON.parse(await file.text());
    } catch {
      return setResult({
        text: `${file.name} isn't a translation file: it isn't JSON.`,
        failed: true,
      });
    }
    await run(
      "preview",
      () => preview({ payload: { id: gameId, catalog } }),
      (counted) => setPending({ name: file.name, catalog, preview: counted }),
    );
  };

  const importTranslations = (catalog: unknown) => {
    setPending(undefined);
    return run(
      "import",
      () =>
        importIt({
          payload: { id: gameId, catalog },
          // A translation file can carry image text too.
          reactivityKeys: { ...catalogKey(gameId), ...imageResultsKey(gameId) },
        }),
      "Imported, after backing up the previous translations. The game shows them from its next start or F5.",
    );
  };

  const clearTranslations = () =>
    run(
      "clear",
      () => clear({ payload: { id: gameId }, reactivityKeys: catalogKey(gameId) }),
      "Cleared all translations, after backing them up. The game shows its original text from its next start or F5.",
    );

  const busy = working !== undefined;
  const label = (action: Action, idle: string, going: string) =>
    working === action ? (
      <>
        <Spinner />
        {going}
      </>
    ) : (
      idle
    );
  return (
    <div className="flex flex-col gap-2">
      <ButtonGroup>
        <Button variant="outline" disabled={busy} onClick={exportTranslations}>
          {label("export", "Export", "Exporting…")}
        </Button>
        <Button variant="outline" disabled={busy || locked} onClick={() => picker.current?.click()}>
          {working === "import" || importing ? (
            <>
              <Spinner />
              {importing?.total
                ? `Importing images: ${importing.done} of ${importing.total}`
                : "Importing…"}
            </>
          ) : (
            label("preview", "Import…", "Reading the file…")
          )}
        </Button>
        <Button variant="outline" disabled={busy || locked} onClick={() => setAsking(true)}>
          {label("clear", "Clear all…", "Clearing…")}
        </Button>
      </ButtonGroup>
      <input
        ref={picker}
        type="file"
        accept=".json,application/json"
        hidden
        aria-label="Translation file to import"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void previewTranslations(file);
        }}
      />
      {result && (
        <p className={result.failed ? "text-sm text-destructive" : "text-sm"}>{result.text}</p>
      )}
      <AlertDialog
        open={pending !== undefined}
        onOpenChange={(open) => !open && setPending(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Import {pending?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The saved translations are backed up first. Entries the file leaves out keep their
              translation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending && (
            <ul className="list-disc ps-5 text-sm">
              {previewLines(pending.preview).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Don't import</AlertDialogCancel>
            <AlertDialogAction onClick={() => pending && void importTranslations(pending.catalog)}>
              Import
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all translations?</AlertDialogTitle>
            <AlertDialogDescription>
              They are backed up first. The glossary stays.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={clearTranslations}>
              Clear all translations
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
