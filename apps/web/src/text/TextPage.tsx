import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Catalog } from "@rpgtl/contracts";
import {
  type EntryText,
  isUserTranslation,
  lastRun,
  type Place,
  placeKey,
  placeOf,
  runTranslates,
  translationInUse,
} from "@rpgtl/domain";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { Button } from "~/components/ui/button";
import { ButtonGroup } from "~/components/ui/button-group";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { failureMessage } from "../app/failure.ts";
import { activity, gameHeld } from "../games/activity.ts";
import { useGameEdits } from "../games/edits.ts";
import { useGame } from "../games/GameContext.ts";
import { catalog, findings } from "../translation/atoms.ts";
import { counted, number } from "../translation/counts.ts";
import { ConfirmDialog } from "../app/ConfirmDialog.tsx";
import { Pager } from "../app/Pager.tsx";
import { clearTranslations, setEntries } from "./atoms.ts";
import { EntryRow } from "./EntryRow.tsx";
import { FileTree, type Selection, type TreeArea } from "./FileTree.tsx";
import {
  areaOf,
  areas,
  changedSearch,
  checkNotes,
  isShown,
  mapNames,
  matches,
  placeLabel,
  type Shown,
  type ShownContext,
  type SearchedText,
  type TextSearch,
  textEntries,
} from "./search.ts";

const searchedTexts: ReadonlyArray<{ readonly within: SearchedText; readonly label: string }> = [
  { within: "both", label: "Both" },
  { within: "original", label: "Original" },
  { within: "english", label: "English" },
];

const filters: ReadonlyArray<{
  readonly show: Shown;
  readonly label: string;
  readonly does: string;
}> = [
  { show: "all", label: "All", does: "Every entry" },
  { show: "untranslated", label: "Untranslated", does: "Entries without English" },
  {
    show: "failed",
    label: "Failed",
    does: "Entries a run couldn't translate, with the answer it rejected",
  },
  { show: "last-run", label: "Last run", does: "Entries the last run translated" },
  { show: "changed", label: "Changed", does: "Entries whose English differs from before clearing" },
  { show: "flagged", label: "Flagged", does: "Translations a check found worth a look" },
];

/** How many entries a page of the list holds. */
const pageSize = 50;

/** The game's text, by place, to read and correct; the address keeps the place, search and filter. */
export function TextPage() {
  const search = useSearch({ from: "/games/$gameId/text" });
  const navigate = useNavigate({ from: "/games/$gameId/text" });
  return (
    <TextEditor search={search} onSearch={(next) => navigate({ search: next, replace: true })} />
  );
}

export function TextEditor({
  search,
  onSearch,
}: {
  readonly search: TextSearch;
  readonly onSearch: (search: TextSearch) => void;
}) {
  const game = useGame();
  const saved = useAtomValue(catalog(game.id));
  return AsyncResult.match(saved, {
    onInitial: () => <Skeleton className="m-6 h-64" />,
    onFailure: ({ cause }) => <p className="p-6 text-destructive">{failureMessage(cause)}</p>,
    onSuccess: ({ value }) => (
      <Text key={game.id} saved={value} search={search} onSearch={onSearch} />
    ),
  });
}

const selectionOf = ({ place, area }: TextSearch): Selection =>
  place !== undefined
    ? { kind: "place", place }
    : area !== undefined
      ? { kind: "area", area }
      : { kind: "all" };

const inSelection = (entry: EntryText, selection: Selection) =>
  selection.kind === "all" ||
  (selection.kind === "area"
    ? areaOf(placeOf(entry.location)) === selection.area
    : placeKey(placeOf(entry.location)) === selection.place);

/** One edit of an entry: its English, or whether it keeps its original. */
type EntryChange = { readonly userTranslation: string } | { readonly isLeftUntranslated: boolean };

const oneLine = (text: string) => {
  const line = text.replace(/\s*\n\s*/g, " ");
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
};

function Text({
  saved,
  search,
  onSearch,
}: {
  readonly saved: Catalog;
  readonly search: TextSearch;
  readonly onSearch: (search: TextSearch) => void;
}) {
  const game = useGame();
  const edits = useGameEdits(game.id);
  const save = useAtomSet(setEntries, { mode: "promiseExit" });
  const clear = useAtomSet(clearTranslations, { mode: "promiseExit" });
  const [clearing, setClearing] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [notice, setNotice] = useState<{ readonly text: string; readonly failed: boolean }>();
  const now = AsyncResult.getOrElse(useAtomValue(activity(game.id)), () => undefined);
  const locked = gameHeld(now);
  const found = AsyncResult.getOrElse(useAtomValue(findings(game.id)), () => ({}));

  // The English as typed here, until a run takes over: the run changes the saved English.
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [wasLocked, setWasLocked] = useState(locked);
  if (locked !== wasLocked) {
    setWasLocked(locked);
    if (locked) {
      setDrafts(new Map());
      setErrors(new Map());
    }
  }
  const typed = useRef(new Set<string>());

  const [page, setPage] = useState(0);
  // Entries edited since the selection, filter or search last changed stay listed, so an entry
  // doesn't leave the Untranslated list while it is being typed into.
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const view = JSON.stringify([
    search.place,
    search.area,
    search.show,
    search.within,
    search.q?.trim().toLowerCase(),
  ]);
  const [shownView, setShownView] = useState(view);
  if (view !== shownView) {
    setShownView(view);
    setPage(0);
    setKept(new Set());
    setNotice(undefined);
  }
  useEffect(() => {
    if (!locked) return;
    for (const id of typed.current) edits.discard(`entry:${id}`);
    typed.current.clear();
  }, [edits, locked]);
  // Leaving the page saves what was typed; an edit that still fails is gone with its draft.
  useEffect(
    () => () => {
      void edits.flush();
      for (const id of typed.current) edits.discard(`entry:${id}`);
    },
    [edits],
  );

  const edit = (entry: EntryText, change: EntryChange, delay: number) => {
    if ("userTranslation" in change) {
      const { userTranslation } = change;
      typed.current.add(entry.id);
      setKept((before) => new Set(before).add(entry.id));
      setDrafts((before) => new Map(before).set(entry.id, userTranslation));
    }
    // Typing replaces the save it hasn't made yet, so keeping the original saves apart from it.
    edits.schedule(
      `${"userTranslation" in change ? "entry" : "keep"}:${entry.id}`,
      async () => {
        const exit = await save({
          payload: { id: game.id, entries: [{ id: entry.id, ...change }] },
        });
        const error = Exit.isFailure(exit) ? failureMessage(exit.cause) : undefined;
        setErrors((before) => {
          const next = new Map(before);
          if (error) next.set(entry.id, error);
          else next.delete(entry.id);
          return next;
        });
        // The header and the run bar show it away from the entry.
        return error && `${oneLine(entry.source)}: ${error}`;
      },
      delay,
    );
  };

  // The search box answers each key at once and the address follows it; a link to the page, such
  // as the run bar's, can change the address's search while the page is open.
  const [query, setQuery] = useState(search.q ?? "");
  const [addressQuery, setAddressQuery] = useState(search.q);
  if (search.q !== addressQuery) {
    setAddressQuery(search.q);
    if ((search.q ?? "") !== query) setQuery(search.q ?? "");
  }
  const searchFor = (text: string) => {
    setQuery(text);
    onSearch(changedSearch(search, { q: text }));
  };

  const show = search.show ?? "all";
  const selection = selectionOf(search);
  const latestRun = lastRun(saved);
  const context: ShownContext = {
    failed: new Set(now?.translation?.failed),
    lastRun: latestRun,
    findings: found,
    translates: runTranslates(saved.settings),
  };
  const wanted = query.trim().toLowerCase();
  const within = search.within ?? "both";
  const text = textEntries(saved);
  const searched = text.filter((entry) => matches(entry, wanted, within));
  const listed = searched.filter((entry) => isShown(entry, show, context));
  const shown = text.filter(
    (entry) =>
      inSelection(entry, selection) &&
      (kept.has(entry.id) ||
        errors.has(entry.id) ||
        (matches(entry, wanted, within) && isShown(entry, show, context))),
  );
  const pages = Math.max(1, Math.ceil(shown.length / pageSize));

  const maps = mapNames(saved);
  const places = new Map<string, { place: Place; count: number }>();
  for (const entry of text) {
    const place = placeOf(entry.location);
    places.set(placeKey(place), { place, count: 0 });
  }
  for (const entry of listed) {
    const known = places.get(placeKey(placeOf(entry.location)));
    if (known) known.count++;
  }
  const tree: ReadonlyArray<TreeArea> = areas.flatMap((area) => {
    const inArea = [...places]
      .filter(([, { place }]) => areaOf(place) === area)
      .map(([key, { place, count }]) => ({ key, label: placeLabel(place, maps), count }));
    if (!inArea.length) return [];
    return [{ area, places: inArea, count: inArea.reduce((sum, place) => sum + place.count, 0) }];
  });
  const english = new Map(
    saved.glossary.map((term) => [term.source, translationInUse(term).trim()]),
  );

  const current = Math.min(page, pages - 1);
  const list = useRef<HTMLDivElement>(null);
  const turn = (to: number) => {
    setPage(to);
    list.current?.scrollTo({ top: 0 });
  };

  const selectedIn = searched.filter((entry) => inSelection(entry, selection));
  const clearable = selectedIn.filter(
    (entry) =>
      isShown(entry, show, context) &&
      !!translationInUse(entry) &&
      !isUserTranslation(entry) &&
      context.translates(entry),
  );
  const clearableTexts = new Set(clearable.map((entry) => entry.textId)).size;
  const clearListed = async () => {
    setNotice(undefined);
    const unsaved = await edits.flush();
    if (unsaved) return setNotice({ text: unsaved, failed: true });
    let cleared = 0;
    setClearing(true);
    const error = await edits.run(async () => {
      const ids = clearable.map((entry) => entry.id);
      const exit = await clear({ payload: { id: game.id, ids } });
      if (Exit.isFailure(exit)) return failureMessage(exit.cause);
      cleared = exit.value.cleared;
      return undefined;
    });
    setClearing(false);
    setNotice(
      error
        ? { text: error, failed: true }
        : {
            text: cleared
              ? `Cleared ${counted(cleared, "translation", "translations")}. Translate translates ${cleared === 1 ? "it" : "them"} again.`
              : "None of these translations came from a run.",
            failed: false,
          },
    );
  };
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[18rem_1fr]">
      <div className="overflow-auto border-r">
        <FileTree
          total={listed.length}
          tree={tree}
          narrowed={show !== "all" || wanted !== ""}
          selected={selection}
          onSelect={(next) =>
            onSearch(
              changedSearch(search, {
                place: next.kind === "place" ? next.place : undefined,
                area: next.kind === "area" ? next.area : undefined,
              }),
            )
          }
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2">
          <Input
            className="h-8 max-w-sm min-w-0 grow basis-40"
            type="search"
            placeholder={selection.kind === "all" ? "Search all text" : "Search this selection"}
            aria-label="Search the text"
            value={query}
            onChange={(event) => searchFor(event.target.value)}
          />
          <ButtonGroup aria-label="Search in" className="shrink-0">
            {searchedTexts.map((option) => (
              <Button
                key={option.within}
                variant={option.within === within ? "secondary" : "outline"}
                size="sm"
                aria-pressed={option.within === within}
                onClick={() => onSearch(changedSearch(search, { within: option.within }))}
              >
                {option.label}
              </Button>
            ))}
          </ButtonGroup>
          <ButtonGroup aria-label="Show" className="shrink-0">
            {filters.map((filter) => (
              <Button
                key={filter.show}
                variant={filter.show === show ? "secondary" : "outline"}
                size="sm"
                aria-pressed={filter.show === show}
                title={filter.does}
                onClick={() => onSearch(changedSearch(search, { show: filter.show }))}
              >
                {filter.label}
                <span className="text-muted-foreground tabular-nums">
                  {number(
                    selectedIn.filter((entry) => isShown(entry, filter.show, context)).length,
                  )}
                </span>
              </Button>
            ))}
          </ButtonGroup>
          <Button
            variant="outline"
            size="sm"
            disabled={locked || clearing || clearable.length === 0}
            title="Clears the English runs gave the entries listed here, so Translate translates them again. English you typed stays."
            onClick={() => setConfirmingClear(true)}
          >
            Clear listed
          </Button>
          <ConfirmDialog
            open={confirmingClear}
            onOpenChange={setConfirmingClear}
            title={`Clear the English of ${counted(clearableTexts, "text", "texts")}?`}
            keep="Keep it"
            confirm="Clear"
            onConfirm={() => void clearListed()}
          >
            Runs gave this English to the entries listed here. Places elsewhere with the same text
            lose it too. English you typed stays.
          </ConfirmDialog>
          {notice && (
            <p
              role="status"
              className={cn("basis-full text-sm", notice.failed && "text-destructive")}
            >
              {notice.text}
            </p>
          )}
        </div>
        <div ref={list} className="min-h-0 flex-1 overflow-auto" role="region" aria-label="Entries">
          {shown.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              {text.length === 0
                ? "This game has no text to translate."
                : "No matching text entries."}
            </p>
          ) : (
            shown
              .slice(current * pageSize, (current + 1) * pageSize)
              .map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  value={drafts.get(entry.id) ?? translationInUse(entry)}
                  where={placeLabel(placeOf(entry.location), maps)}
                  speaker={
                    entry.speaker === undefined
                      ? undefined
                      : english.get(entry.speaker) || entry.speaker
                  }
                  notes={checkNotes(entry, found)}
                  fromLastRun={latestRun !== undefined && entry.modelOperationId === latestRun}
                  error={errors.get(entry.id)}
                  locked={locked}
                  onChange={(userTranslation, delay) => edit(entry, { userTranslation }, delay)}
                  onKeepOriginal={(isLeftUntranslated) => edit(entry, { isLeftUntranslated }, 0)}
                />
              ))
          )}
        </div>
        <Pager
          count={counted(shown.length, "entry", "entries")}
          page={current}
          pages={pages}
          turn={turn}
        />
      </div>
    </div>
  );
}
