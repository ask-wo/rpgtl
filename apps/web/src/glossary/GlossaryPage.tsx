import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Catalog, GlossaryTerm, TermKind } from "@rpgtl/contracts";
import {
  entryTexts,
  glossaryFindings,
  glossaryOrder,
  lastRun,
  savedTerm,
  termEdit,
  termKind,
  termPronoun,
  textsToClear,
  translationInUse,
  withRenamesFollowed,
} from "@rpgtl/domain";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Field, FieldLabel } from "~/components/ui/field";
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
import { clearTermLines, clearTermTranslations, setGlossary } from "./atoms.ts";
import { TermDetail } from "./TermDetail.tsx";

const sections: ReadonlyArray<{ readonly kind: TermKind; readonly label: string }> = [
  { kind: "character", label: "Characters" },
  { kind: "name", label: "Names" },
  { kind: "word", label: "Words" },
];

type Shown = "all" | "untranslated" | "last-run" | "changed" | "flagged" | "custom";

const filters: ReadonlyArray<{
  readonly show: Shown;
  readonly label: string;
  readonly does: string;
}> = [
  { show: "all", label: "All", does: "Every term" },
  { show: "untranslated", label: "Untranslated", does: "Terms without English" },
  { show: "last-run", label: "Last run", does: "Terms the last run translated" },
  { show: "changed", label: "Changed", does: "Terms whose English differs from before clearing" },
  { show: "flagged", label: "Flagged", does: "Terms whose English leaves out a name inside them" },
  { show: "custom", label: "Custom", does: "Terms whose English, kind or pronoun you set" },
];

/** Whether the user set any of the term's values. */
const isCustom = ({ userTranslation, userKind, userPronoun }: GlossaryTerm) =>
  userTranslation !== undefined || userKind !== undefined || userPronoun !== undefined;

/** An id for a term the user adds, below 0 and below every other new term's until it is saved. */
const newTermId = (glossary: ReadonlyArray<GlossaryTerm>) =>
  Math.min(0, ...glossary.map((term) => term.id)) - 1;

/**
 * The glossary the user typed, with the renames it makes followed from `saved`, and each term's
 * English from a run as `saved` has it, since a run may have given other English since.
 */
const followed = (
  saved: ReadonlyArray<GlossaryTerm>,
  typed: ReadonlyArray<GlossaryTerm>,
): ReadonlyArray<GlossaryTerm> => {
  const before = new Map(saved.map((term) => [term.source, term]));
  return withRenamesFollowed(
    saved,
    typed.map((term): GlossaryTerm => {
      const { modelTranslation: _, modelOperationId: __, ...rest } = term;
      const known = before.get(term.source);
      return {
        ...rest,
        ...(known?.modelTranslation !== undefined && { modelTranslation: known.modelTranslation }),
        ...(known?.modelOperationId !== undefined && { modelOperationId: known.modelOperationId }),
      };
    }),
  );
};

/** What the filters need besides the term. */
interface Seen {
  /** The operation id of the last run that gave a text its English. */
  readonly lastRun: number | undefined;
  /** The saved glossary's findings, by term source. */
  readonly flagged: ReadonlyMap<string, ReadonlyArray<string>>;
}

function isShown(term: GlossaryTerm, show: Shown, { lastRun: last, flagged }: Seen) {
  const english = translationInUse(term).trim();
  switch (show) {
    case "all":
      return true;
    case "untranslated":
      return !english;
    case "last-run":
      return last !== undefined && term.modelOperationId === last;
    case "changed":
      return !!english && term.previousTranslation !== undefined;
    case "flagged":
      return flagged.has(term.source);
    case "custom":
      return isCustom(term);
  }
}

/** Whether the list shows the term with this filter and search. */
function isListed(term: GlossaryTerm, show: Shown, seen: Seen, filter: string) {
  const query = filter.trim().toLowerCase();
  return (
    isShown(term, show, seen) &&
    (!query || `${term.source} ${translationInUse(term)}`.toLowerCase().includes(query))
  );
}

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
  const clearModelTranslations = useAtomSet(clearTermTranslations, { mode: "promiseExit" });
  const locked = gameHeld(AsyncResult.getOrElse(useAtomValue(activity(game.id)), () => undefined));

  // The glossary as typed here, until a run takes over: the run changes the saved one. The renames
  // it makes are followed from the saved glossary, so a rename typed over doesn't stay in a term.
  const [draft, setDraft] = useState<ReadonlyArray<GlossaryTerm>>();
  // What waits for the user to confirm; a run that takes the game closes it.
  const [removingAll, setRemovingAll] = useState(false);
  const [keepCustom, setKeepCustom] = useState(true);
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
  const typed = (!locked && draft) || saved.glossary;
  const glossary = useMemo(
    () => (typed === saved.glossary ? typed : followed(saved.glossary, typed)),
    [typed, saved.glossary],
  );
  // A large game's glossary takes a tenth of a second to check, too long to do on every key.
  const flagged = useMemo(() => glossaryFindings(saved.glossary), [saved.glossary]);
  const entries = useMemo(() => entryTexts(saved), [saved]);
  const latestRun = lastRun(saved);
  const seen: Seen = { lastRun: latestRun, flagged };
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
  const [show, setShow] = useState<Shown>("all");
  const [notice, setNotice] = useState<Notice>();
  const [clearing, setClearing] = useState(false);

  const edit = (edited: ReadonlyArray<GlossaryTerm>, delay: number) => {
    const next = followed(saved.glossary, edited);
    setDraft(edited);
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

  const clearable = glossary.filter(
    (each) => each.userTranslation === undefined && isListed(each, "flagged", seen, filter),
  );
  const clearFlagged = async () => {
    setNotice(undefined);
    const unsaved = await edits.flush();
    if (unsaved) return setNotice({ text: unsaved, failed: true });
    let cleared = { terms: 0, texts: 0 };
    setClearing(true);
    const error = await edits.run(async () => {
      const sources = clearable.map((each) => each.source);
      const exit = await clearModelTranslations({ payload: { id: game.id, sources } });
      if (Exit.isFailure(exit)) return failureMessage(exit.cause);
      cleared = exit.value;
      // The edits were saved before clearing, so the saved glossary, cleared, is the one to show.
      setDraft(undefined);
      return undefined;
    });
    setClearing(false);
    setNotice(
      error
        ? { text: error, failed: true }
        : {
            text: cleared.terms
              ? `Cleared ${counted(cleared.terms, "term", "terms")} and ${counted(cleared.texts, "translation", "translations")} with them. Translate translates them again.`
              : "None of these terms has English from a run and a line of its own to translate it from.",
            failed: false,
          },
    );
  };

  const order = glossaryOrder(glossary, entries);
  const current = selected ?? order[0];
  const term = current === undefined ? undefined : glossary[current];
  const custom = glossary.filter(isCustom).length;
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
        <div
          className="flex min-h-0 flex-col border-r text-sm"
          aria-label="Glossary terms"
          role="region"
        >
          <div className="flex flex-wrap gap-2 border-b bg-background p-2">
            <Input
              className="h-8 min-w-0 flex-1"
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
                if (blank === -1)
                  edit([...typed, savedTerm(undefined, { source: "" }, newTermId(typed))], 0);
                setFilter("");
                setShow("all");
                setSelected(blank === -1 ? glossary.length : blank);
              }}
            >
              <PlusIcon />
              Add term
            </Button>
            <div role="group" aria-label="Show" className="flex basis-full flex-wrap gap-1">
              {filters.map((each) => (
                <Button
                  key={each.show}
                  variant={each.show === show ? "secondary" : "outline"}
                  size="sm"
                  className="gap-1 px-2 text-xs"
                  aria-pressed={each.show === show}
                  title={each.does}
                  onClick={() => setShow(each.show)}
                >
                  {each.label}
                  <span className="text-muted-foreground tabular-nums">
                    {number(glossary.filter((one) => isShown(one, each.show, seen)).length)}
                  </span>
                </Button>
              ))}
            </div>
            {show === "flagged" && (
              <Button
                variant="outline"
                size="sm"
                disabled={locked || clearing || clearable.length === 0}
                title="Clears the English a run gave the flagged terms listed here and the lines with them, so Translate translates them again. English you typed stays."
                onClick={() => void clearFlagged()}
              >
                Clear flagged
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <TermList
              glossary={glossary}
              order={order}
              filter={filter}
              show={show}
              seen={seen}
              current={current}
              locked={locked}
              onSelect={setSelected}
              onRemove={setRemoving}
            />
          </div>
        </div>
        <div className="min-w-0 overflow-auto p-6">
          {term !== undefined && current !== undefined && (
            <TermDetail
              lastRun={latestRun}
              missing={flagged.get(term.source) ?? []}
              key={current}
              term={term}
              glossary={glossary}
              entries={entries}
              texts={saved.texts}
              locked={locked || clearing}
              onChange={(changed, delay) => edit(typed.with(current, changed), delay)}
              onDone={() => edits.flush()}
              onClearAll={() => setClearingAll(true)}
              onClearMismatches={() =>
                clearFor([term.source], true, (cleared) =>
                  cleared
                    ? `Cleared ${counted(cleared, "translation", "translations")} of ${term.source} that didn't use ${translationInUse(term).trim()}. Translate translates ${cleared === 1 ? "it" : "them"} again.`
                    : `Every translation with ${term.source} already uses ${translationInUse(term).trim()}.`,
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
          edit(keepCustom ? typed.filter(isCustom) : [], 0);
          setSelected(undefined);
        }}
        options={
          custom > 0 && (
            <Field orientation="horizontal">
              <Checkbox
                id="keep-custom-terms"
                checked={keepCustom}
                onCheckedChange={setKeepCustom}
              />
              <FieldLabel htmlFor="keep-custom-terms">
                Keep the {counted(custom, "term", "terms")} you set yourself
              </FieldLabel>
            </Field>
          )
        }
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
          edit(typed.toSpliced(index, 1), 0);
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
          {`Clears ${counted(textsToClear(saved, term, false).length, "translated line", "translated lines")}. Translate translates them again.`}
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * The terms by kind, in `order`, that `filter` matches. Apart from the page, so a save that leaves
 * the glossary as it was doesn't draw a large game's thousands of terms again.
 */
function TermList({
  glossary,
  order,
  filter,
  show,
  seen,
  current,
  locked,
  onSelect,
  onRemove,
}: {
  readonly glossary: ReadonlyArray<GlossaryTerm>;
  readonly order: ReadonlyArray<number>;
  readonly filter: string;
  readonly show: Shown;
  readonly seen: Seen;
  readonly current: number | undefined;
  readonly locked: boolean;
  readonly onSelect: (index: number) => void;
  readonly onRemove: (term: GlossaryTerm) => void;
}) {
  const shown = order.filter((index) => {
    const term = glossary[index];
    return term !== undefined && isListed(term, show, seen, filter);
  });
  return glossary.length === 0 ? (
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
          <h3 className="sticky top-0 bg-sidebar px-3 py-1.5 text-xs font-medium text-muted-foreground">
            {label} · {number(terms.length)}
          </h3>
          {terms.map((index) => {
            const each = glossary[index];
            if (!each) return null;
            return (
              // A large game's glossary has thousands of rows, which every save lays out
              // again unless the browser may skip the ones out of view.
              <div
                key={index}
                className="group/term relative [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]"
              >
                <button
                  type="button"
                  aria-current={index === current || undefined}
                  onClick={() => onSelect(index)}
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
                  <span className="block text-muted-foreground">{translationInUse(each)}</span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={locked}
                  aria-label={`Remove ${each.source || "the new term"} from the glossary`}
                  className="absolute top-1.5 right-2 opacity-0 group-focus-within/term:opacity-100 group-hover/term:opacity-100"
                  onClick={() => onRemove(each)}
                >
                  <XIcon />
                </Button>
              </div>
            );
          })}
        </section>
      );
    })
  );
}
