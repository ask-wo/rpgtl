import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Catalog, Entry, Game, ImageReadResults, ImageResult } from "@rpgtl/contracts";
import { gameLanguage, withTranslation, withImageText } from "@rpgtl/domain";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ButtonGroup } from "~/components/ui/button-group";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { failureMessage } from "../app/failure.ts";
import { activity, gameHeld, runPending } from "../games/activity.ts";
import { useGameEdits } from "../games/edits.ts";
import { useGame } from "../games/GameContext.ts";
import { setEntries } from "../text/atoms.ts";
import { catalog, catalogKey, imageResultsKey } from "../translation/atoms.ts";
import { counted, number } from "../translation/counts.ts";
import { Pager } from "../app/Pager.tsx";
import { clearImageText, imageReaderStatus, imageResults, setImageOptions } from "./atoms.ts";
import { ImageEditor, type TextChange } from "./ImageEditor.tsx";
import {
  type ImageFilter,
  imagesWithText,
  imageState,
  isListed,
  type ListedImage,
} from "./imageList.ts";
import { InGameImage, seriesResults, type ShownImages } from "./InGameImage.tsx";
import { type Lettering, LetteringRow } from "./LetteringRow.tsx";
import { useReadImages } from "./readImages.ts";
import { readsLanguage } from "./readerSetup.ts";

const filters: ReadonlyArray<{ readonly filter: ImageFilter; readonly label: string }> = [
  { filter: "all", label: "All" },
  { filter: "untranslated", label: "With untranslated text" },
  { filter: "kept", label: "With original artwork kept" },
];

/** How many images a page of the grid holds. */
const pageSize = 48;

/** The game's images with text, as the game will show them, to correct their English. */
export function ImagesPage() {
  const game = useGame();
  const saved = useAtomValue(catalog(game.id));
  const results = useAtomValue(imageResults(game.id));
  const both = AsyncResult.all([saved, results]);
  return AsyncResult.match(both, {
    onInitial: () => <Skeleton className="m-6 h-64" />,
    onFailure: ({ cause }) => <p className="p-6 text-destructive">{failureMessage(cause)}</p>,
    onSuccess: ({ value: [current, read] }) => (
      <Images key={game.id} game={game} saved={current} results={read} />
    ),
  });
}

const failure = (exit: Exit.Exit<unknown, { readonly message: string }>) =>
  Exit.isFailure(exit) ? failureMessage(exit.cause) : undefined;

const fileName = (image: string) => image.slice(image.lastIndexOf("/") + 1);
const folderOf = (image: string) => image.slice(0, image.lastIndexOf("/") + 1);

function Images({
  game,
  saved,
  results,
}: {
  readonly game: Game;
  readonly saved: Catalog;
  readonly results: ImageReadResults;
}) {
  const edits = useGameEdits(game.id);
  const saveEntries = useAtomSet(setEntries, { mode: "promiseExit" });
  const saveOptions = useAtomSet(setImageOptions, { mode: "promiseExit" });
  const clear = useAtomSet(clearImageText, { mode: "promiseExit" });
  const now = AsyncResult.getOrElse(useAtomValue(activity(game.id)), () => undefined);
  const locked = gameHeld(now);
  const reading = useReadImages();
  const reader = AsyncResult.getOrElse(useAtomValue(imageReaderStatus), () => undefined);
  const readerUsable = reader !== undefined && readsLanguage(reader, gameLanguage(saved));

  // What was typed or chosen here, until a run takes over or the image text is cleared.
  const [typed, setTyped] = useState<ReadonlyMap<string, TextChange>>(new Map());
  const [keptImages, setKeptImages] = useState<ReadonlyArray<string>>();
  const [lettering, setLettering] = useState<Lettering>();
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const keys = useRef(new Set<string>());
  const dropDrafts = () => {
    setTyped(new Map());
    setKeptImages(undefined);
    setLettering(undefined);
    setErrors(new Map());
  };
  const discardEdits = () => {
    for (const key of keys.current) edits.discard(key);
    keys.current.clear();
  };
  const [wasLocked, setWasLocked] = useState(locked);
  if (locked !== wasLocked) {
    setWasLocked(locked);
    if (locked) dropDrafts();
  }
  useEffect(() => {
    if (locked) discardEdits();
  }, [edits, locked]);
  // Leaving the page saves what was typed; an edit that still fails is gone with its draft.
  useEffect(
    () => () => {
      void edits.flush();
      for (const key of keys.current) edits.discard(key);
    },
    [edits],
  );

  const { imageBold, imageFont } = lettering ?? saved;
  const unchangedImages = keptImages ?? saved.unchangedImages;
  const shown: ShownImages = {
    entries: saved.entries.map((entry) => {
      const change = typed.get(entry.id);
      if (!change) return entry;
      const corrected =
        change.text === undefined ? entry : withImageText(entry, change.text.trim());
      const typedTranslation =
        change.translation === undefined
          ? corrected
          : withTranslation(corrected, change.translation);
      return change.keepOriginal === undefined
        ? typedTranslation
        : { ...typedTranslation, keepOriginal: change.keepOriginal };
    }),
    ...(imageBold && { imageBold }),
    ...(imageFont && { imageFont }),
    ...(unchangedImages && { unchangedImages }),
  };

  const schedule = (key: string, save: () => Promise<string | undefined>, delay: number) => {
    keys.current.add(key);
    edits.schedule(key, save, delay);
  };

  const changeText = (entry: Entry, change: TextChange, delay: number) => {
    setTyped((before) => new Map(before).set(entry.id, { ...before.get(entry.id), ...change }));
    // The English, the text and the artwork save apart, so a click doesn't drop a pause in typing.
    const part =
      change.text !== undefined ? "text" : change.translation !== undefined ? "entry" : "keep";
    const key = `${part}:${entry.id}`;
    schedule(
      key,
      async () => {
        const error = failure(
          await saveEntries({ payload: { id: game.id, entries: [{ id: entry.id, ...change }] } }),
        );
        setErrors((before) => {
          const next = new Map(before);
          if (error) next.set(key, error);
          else next.delete(key);
          return next;
        });
        return error && `${entry.file}, ${entry.source}: ${error}`;
      },
      delay,
    );
  };

  const keepWhole = (image: string, keep: boolean) => {
    const others = (shown.unchangedImages ?? []).filter((kept) => kept !== image);
    const next = keep ? [...others, image] : others;
    setKeptImages(next);
    schedule(
      "kept-images",
      async () => failure(await saveOptions({ payload: { id: game.id, unchangedImages: next } })),
      0,
    );
  };

  const changeLettering = (next: Lettering) => {
    setLettering(next);
    schedule(
      "lettering",
      async () =>
        failure(
          await saveOptions({
            payload: {
              id: game.id,
              imageBold: next.imageBold ?? null,
              imageFont: next.imageFont ?? null,
            },
          }),
        ),
      0,
    );
  };

  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState<{ readonly text: string; readonly failed: boolean }>();
  const clearAll = async () => {
    setClearing(true);
    setCleared(undefined);
    await edits.flush();
    discardEdits();
    dropDrafts();
    const error = await edits.run(async () =>
      failure(
        await clear({
          payload: { id: game.id },
          reactivityKeys: { ...catalogKey(game.id), ...imageResultsKey(game.id) },
        }),
      ),
    );
    setClearing(false);
    setCleared(
      error
        ? { text: error, failed: true }
        : {
            text: "Cleared the image text. The game shows its original images from its next start or F5.",
            failed: false,
          },
    );
  };

  const [filter, setFilter] = useState<ImageFilter>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string>();
  // The list the editor walks stays as it was when the image opened, so an edit that changes
  // whether an image passes the filter doesn't move it out from under the editor.
  const [walked, setWalked] = useState<ReadonlyArray<string>>([]);

  const all = imagesWithText(results, shown);
  const wanted = query.trim().toLowerCase();
  const listed = all.filter((item) => isListed(item, filter, wanted, shown));
  const pages = Math.max(1, Math.ceil(listed.length / pageSize));
  const current = Math.min(page, pages - 1);
  const opened = open === undefined ? undefined : all.find((item) => item.image === open);
  // Reading the open image again can leave it without text, which closes the editor.
  if (open !== undefined && opened === undefined) setOpen(undefined);
  const openImage = (image: string) => {
    if (open === undefined) setWalked(listed.map((item) => item.image));
    setOpen(image);
  };
  const index = open === undefined ? -1 : walked.indexOf(open);
  const letteringRow = (
    <>
      <LetteringRow
        game={game}
        shown={shown}
        locked={locked}
        clearing={clearing}
        onLettering={changeLettering}
        onClear={clearAll}
      />
      {cleared && <ClearedLine {...cleared} />}
    </>
  );

  if (all.length === 0)
    return (
      <div className="flex flex-col">
        {letteringRow}
        <p className="p-6 text-sm text-muted-foreground">
          No images with text yet. Read new images finds it.
        </p>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {letteringRow}
      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2">
        <Input
          className="h-8 max-w-sm"
          type="search"
          placeholder="Search image paths and text"
          aria-label="Search the images"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
        <ButtonGroup aria-label="Show">
          {filters.map((choice) => (
            <Button
              key={choice.filter}
              variant={choice.filter === filter ? "secondary" : "outline"}
              size="sm"
              aria-pressed={choice.filter === filter}
              onClick={() => {
                setFilter(choice.filter);
                setPage(0);
              }}
            >
              {choice.label}
              <span className="text-muted-foreground tabular-nums">
                {number(all.filter((item) => isListed(item, choice.filter, wanted, shown)).length)}
              </span>
            </Button>
          ))}
        </ButtonGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-6" role="region" aria-label="Images">
        {listed.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matching images.</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-4">
            {listed.slice(current * pageSize, (current + 1) * pageSize).map((item) => (
              <ImageCard
                key={item.image}
                game={game}
                item={item}
                series={seriesResults(results, item.image)}
                shown={shown}
                onOpen={() => openImage(item.image)}
              />
            ))}
          </div>
        )}
      </div>
      <Pager
        count={counted(listed.length, "image", "images")}
        page={current}
        pages={pages}
        turn={setPage}
      />
      {opened && (
        <ImageEditor
          game={game}
          listed={opened}
          series={seriesResults(results, opened.image)}
          shown={shown}
          position={index < 0 ? undefined : { index, of: walked.length }}
          errors={errors}
          locked={locked}
          onChange={changeText}
          onKeepWhole={(keep) => keepWhole(opened.image, keep)}
          onStep={(by) => {
            const next = walked[index + by];
            if (next !== undefined) setOpen(next);
          }}
          onClose={() => setOpen(undefined)}
          readAgain={{
            run: () => void reading.run([opened.image]),
            ready: readerUsable && !reading.starting && !runPending(now),
            error: reading.error,
          }}
        />
      )}
    </div>
  );
}

function ClearedLine({ text, failed }: { readonly text: string; readonly failed: boolean }) {
  return <p className={`border-b px-6 py-2 text-sm ${failed ? "text-destructive" : ""}`}>{text}</p>;
}

function ImageCard({
  game,
  item,
  series,
  shown,
  onOpen,
}: {
  readonly game: Game;
  readonly item: ListedImage;
  readonly series: Readonly<Record<string, ImageResult>>;
  readonly shown: ShownImages;
  readonly onOpen: () => void;
}) {
  const state = imageState(item, shown);
  return (
    <button
      type="button"
      className="flex flex-col gap-1 rounded-lg border p-2 text-left text-sm hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      title={item.image}
      aria-label={`Open ${item.image}`}
      onClick={onOpen}
    >
      <div className="flex aspect-video items-center justify-center overflow-hidden rounded bg-muted">
        <InGameImage
          game={game}
          image={item.image}
          result={item.result}
          series={series}
          shown={shown}
          className="max-h-full max-w-full object-contain"
        />
      </div>
      <span className="truncate font-medium">{fileName(item.image)}</span>
      <span className="truncate text-xs text-muted-foreground">{folderOf(item.image)}</span>
      <span className={`text-xs ${state.done ? "text-muted-foreground" : ""}`}>{state.text}</span>
    </button>
  );
}
