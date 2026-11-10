import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Catalog, GlossaryTerm, TermKind } from "@rpgtl/contracts";
import {
  entriesToClear,
  glossaryOrder,
  savedTerm,
  termEdit,
  termTranslation,
  termKind,
  termPronoun,
} from "@rpgtl/domain";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "cn";
import { ConfirmDialog } from "../app/ConfirmDialog.tsx";
import { failureMessage } from "../app/failure.ts";
import { activity, gameHeld } from "../games/activity.ts";
import { useGameEdits } from "../games/edits.ts";
import { useGame } from "../games/GameContext.ts";
import { catalog } from "../translation/atoms.ts";
import { counted, number } from "../translation/counts.ts";
import { clearTermLines, setGlossary } from "./atoms.ts";
import { TermDetail } from "./TermDetail.tsx";

const sections: ReadonlyArray<{ readonly kind: TermKind; readonly label: string }> = [
  { kind: "character", label: "Characters" },
  { kind: "name", label: "Names" },
  { kind: "word", label: "Words" },
];

/** The game's glossary, which every translation follows. */
export function GlossaryPage() {
  const game = useGame();
  const saved = useAtomValue(catalog(game.id));
  return AsyncResult.match(saved, {
    onInitial: () => <Skeleton className="m-6 h-64" />,
    onFailure: ({ cause }) => <p className="p-6 text-destructive">{failureMessage(cause)}</p>,
    onSuccess: ({ value }) => <Glossary key={game.id} saved={value} />,
  });
}

/** What a change to the glossary does, for the page to say. */
type Notice = { readonly text: string; readonly failed: boolean };

function Glossary({ saved }: { readonly saved: Catalog }) {
  const game = useGame();
  const edits = useGameEdits(game.id);
  const save = useAtomSet(setGlossary, { mode: "promiseExit" });
  const clear = useAtomSet(clearTermLines, { mode: "promiseExit" });
  const locked = gameHeld(AsyncResult.getOrElse(useAtomValue(activity(game.id)), () => undefined));

  // The glossary as edited here, until a run takes over: the run changes the saved one.
  const [draft, setDraft] = useState<ReadonlyArray<GlossaryTerm>>();
  // What waits for the user to confirm; a run that takes the game closes it.
  const [removingAll, setRemovingAll] = useState(false);
  const [removing, setRemoving] = useState<GlossaryTerm>();
  const [clearingAll, setClearingAll] = useState(false);
  const [wasLocked, setWasLocked] = useState(locked);
  if (locked !== wasLocked) {
    setWasLocked(locked);
    if (locked) {
      setDraft(undefined);
      setRemovingAll(false);
      setRemoving(undefined);
      setClearingAll(false);
    }
  }
  const glossary = (!locked && draft) || saved.glossary;
  useEffect(() => {
    if (locked) edits.discard("glossary");
  }, [edits, locked]);
  // Leaving the page saves what was typed; an edit that still fails is gone with the draft.
  useEffect(
    () => () => {
      void edits.flush();
      edits.discard("glossary");
    },
    [edits],
  );

  const [selected, setSelected] = useState<number>();
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState<Notice>();
  const [clearing, setClearing] = useState(false);

  const edit = (next: ReadonlyArray<GlossaryTerm>, delay: number) => {
    setDraft(next);
    setNotice(undefined);
    edits.schedule(
      "glossary",
      async () => {
        const exit = await save({
          payload: {
            id: game.id,
            glossary: next.filter((term) => term.source.trim() !== "").map(termEdit),
          },
        });
        return Exit.isFailure(exit) ? failureMessage(exit.cause) : undefined;
      },
      delay,
    );
  };

  const clearFor = async (
    sources: ReadonlyArray<string>,
    mismatchesOnly: boolean,
    describe: (cleared: number) => string,
  ) => {
    setNotice(undefined);
    const unsaved = await edits.flush();
    if (unsaved) return setNotice({ text: unsaved, failed: true });
    let cleared = 0;
    setClearing(true);
    const error = await edits.run(async () => {
      const exit = await clear({ payload: { id: game.id, sources, mismatchesOnly } });
      if (Exit.isFailure(exit)) return failureMessage(exit.cause);
      cleared = exit.value.cleared;
      return undefined;
    });
    setClearing(false);
    setNotice(error ? { text: error, failed: true } : { text: describe(cleared), failed: false });
  };

  const order = glossaryOrder(glossary, saved.entries);
  const query = filter.trim().toLowerCase();
  const shown = order.filter((index) => {
    const term = glossary[index];
    return (
      term !== undefined &&
      (!query || `${term.source} ${termTranslation(term)}`.toLowerCase().includes(query))
    );
  });
  const current = selected ?? order[0];
  const term = current === undefined ? undefined : glossary[current];
  const characters = glossary.filter(
    (each) => termKind(each) === "character" && each.source.trim(),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2 border-b px-6 py-3">
        <p className="min-w-80 flex-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Build glossary</span> translates the game's
          names into the glossary, sorts them by kind and finds characters' pronouns. Correct them
          here before translating the rest, since every line that uses a name follows the glossary.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={locked || clearing || characters.length === 0}
            title="Clears translations that don't use a character's English name, so Translate redoes them"
            onClick={() =>
              clearFor(
                characters.map((each) => each.source),
                true,
                (cleared) =>
                  cleared
                    ? `Cleared ${counted(cleared, "translation", "translations")} that didn't use a character's English name. Translate translates ${cleared === 1 ? "it" : "them"} again.`
                    : "Every translation already uses its characters' English names.",
              )
            }
          >
            Clear all wrong text
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={locked || glossary.length === 0}
            onClick={() => setRemovingAll(true)}
          >
            Remove glossary…
          </Button>
        </div>
        {notice && (
          <p
            role="status"
            className={cn("basis-full text-sm", notice.failed && "text-destructive")}
          >
            {notice.text}
          </p>
        )}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[22rem_1fr]">
        <div className="overflow-auto border-r text-sm" aria-label="Glossary terms" role="region">
          <div className="sticky top-0 z-10 flex gap-2 border-b bg-background p-2">
            <Input
              className="h-8"
              placeholder="Filter terms"
              aria-label="Filter terms"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <Button
              size="sm"
              disabled={locked}
              onClick={() => {
                const blank = glossary.findIndex((each) => !each.source.trim());
                if (blank === -1) edit([...glossary, savedTerm(undefined, { source: "" })], 0);
                setFilter("");
                setSelected(blank === -1 ? glossary.length : blank);
              }}
            >
              <PlusIcon />
              Add term
            </Button>
          </div>
          {glossary.length === 0 ? (
            <p className="p-3 text-muted-foreground">
              No glossary terms yet. Build glossary fills it from the game's names.
            </p>
          ) : shown.length === 0 ? (
            <p className="p-3 text-muted-foreground">No matching terms.</p>
          ) : (
            sections.map(({ kind, label }) => {
              const terms = shown.filter((index) => {
                const each = glossary[index];
                return each !== undefined && termKind(each) === kind;
              });
              if (terms.length === 0) return null;
              return (
                <section key={kind} aria-label={label}>
                  <h3 className="sticky top-12 bg-sidebar px-3 py-1.5 text-xs font-medium text-muted-foreground">
                    {label} · {number(terms.length)}
                  </h3>
                  {terms.map((index) => {
                    const each = glossary[index];
                    if (!each) return null;
                    return (
                      <div key={index} className="group/term relative">
                        <button
                          type="button"
                          aria-current={index === current || undefined}
                          onClick={() => setSelected(index)}
                          className="block w-full border-b px-3 py-1.5 text-left hover:bg-accent aria-[current]:bg-accent"
                        >
                          <span className="flex items-center gap-2">
                            <span>{each.source || "New term"}</span>
                            {kind === "character" && (
                              <Badge
                                variant="outline"
                                className="ml-auto transition-none group-focus-within/term:opacity-0 group-hover/term:opacity-0"
                              >
                                {termPronoun(each) ?? "unknown"}
                              </Badge>
                            )}
                          </span>
                          <span className="block text-muted-foreground">
                            {termTranslation(each)}
                          </span>
                        </button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={locked}
                          aria-label={`Remove ${each.source || "the new term"} from the glossary`}
                          className="absolute top-1.5 right-2 opacity-0 group-focus-within/term:opacity-100 group-hover/term:opacity-100"
                          onClick={() => setRemoving(each)}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    );
                  })}
                </section>
              );
            })
          )}
        </div>
        <div className="min-w-0 overflow-auto p-6">
          {term !== undefined && current !== undefined && (
            <TermDetail
              key={current}
              term={term}
              glossary={glossary}
              entries={saved.entries}
              locked={locked || clearing}
              onChange={(changed, delay) => edit(glossary.with(current, changed), delay)}
              onDone={() => edits.flush()}
              onClearAll={() => setClearingAll(true)}
              onClearMismatches={() =>
                clearFor([term.source], true, (cleared) =>
                  cleared
                    ? `Cleared ${counted(cleared, "translation", "translations")} of ${term.source} that didn't use ${termTranslation(term).trim()}. Translate translates ${cleared === 1 ? "it" : "them"} again.`
                    : `Every translation with ${term.source} already uses ${termTranslation(term).trim()}.`,
                )
              }
            />
          )}
        </div>
      </div>
      <ConfirmDialog
        open={removingAll}
        onOpenChange={setRemovingAll}
        title="Remove the glossary?"
        keep="Keep it"
        confirm="Remove glossary"
        onConfirm={() => {
          edit([], 0);
          setSelected(undefined);
        }}
      >
        The translations stay. Build glossary fills it again.
      </ConfirmDialog>
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => open || setRemoving(undefined)}
        title={`Remove ${removing?.source || "the new term"} from the glossary?`}
        keep="Keep it"
        confirm="Remove"
        onConfirm={() => {
          const index = removing === undefined ? -1 : glossary.indexOf(removing);
          if (index === -1) return;
          edit(glossary.toSpliced(index, 1), 0);
          setSelected(undefined);
        }}
      >
        Its lines keep their translations.
      </ConfirmDialog>
      {term !== undefined && (
        <ConfirmDialog
          open={clearingAll}
          onOpenChange={setClearingAll}
          title={`Clear the translation of every line with ${term.source.trim()}?`}
          keep="Keep them"
          confirm="Clear all text"
          onConfirm={() =>
            clearFor([term.source], false, (cleared) =>
              cleared
                ? `Cleared ${counted(cleared, "translation", "translations")} of ${term.source.trim()}. Translate translates ${cleared === 1 ? "it" : "them"} again.`
                : `No line with ${term.source.trim()} is translated.`,
            )
          }
        >
          {`Clears ${counted(entriesToClear(saved, term, false).length, "translated line", "translated lines")}, after backing them up. Translate translates them again.`}
        </ConfirmDialog>
      )}
    </div>
  );
}
