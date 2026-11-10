import type { Entry, Game, ImageResult } from "@rpgtl/contracts";
import { ChevronLeftIcon, ChevronRightIcon, PencilIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Field, FieldLabel } from "~/components/ui/field";
import { Textarea } from "~/components/ui/textarea";
import { number } from "../translation/counts.ts";
import { imageAssets } from "./assets.ts";
import { keptWhole, type ListedImage } from "./imageList.ts";
import { InGameImage, type ShownImages } from "./InGameImage.tsx";
import { entryTranslation } from "@rpgtl/domain";

/** What the user changed on one of the image's texts. */
export interface TextChange {
  readonly translation?: string;
  /** The text the image shows, where the reader got it wrong. */
  readonly text?: string;
  readonly keepOriginal?: boolean;
}

/**
 * One image with its texts: the original beside the image as the game shows it, each text as read,
 * which the user can correct, its English and whether it keeps its original artwork. Previous and
 * next (Alt+←/→) walk the images the page lists.
 */
export function ImageEditor({
  game,
  listed,
  series,
  shown,
  position,
  errors,
  locked,
  onChange,
  onKeepWhole,
  onStep,
  onClose,
  readAgain,
}: {
  readonly game: Game;
  /** The image as typed on the page. */
  readonly listed: ListedImage;
  /** The results of the other images of its series, whose English takes one size with its own. */
  readonly series: Readonly<Record<string, ImageResult>>;
  readonly shown: ShownImages;
  /** Where the image is in the page's list, and how many it lists. */
  readonly position: { readonly index: number; readonly of: number } | undefined;
  /**
   * Why a text's change couldn't be saved, by its save key (`entry:<id>`, `text:<id>` or
   * `keep:<id>`).
   */
  readonly errors: ReadonlyMap<string, string>;
  readonly locked: boolean;
  /** Saves a text's change after `delay` ms, so typing saves once it pauses. */
  readonly onChange: (entry: Entry, change: TextChange, delay: number) => void;
  readonly onKeepWhole: (keep: boolean) => void;
  /** Opens the previous (-1) or next (1) listed image. */
  readonly onStep: (by: -1 | 1) => void;
  readonly onClose: () => void;
  /** Reads the image again from scratch, unless reading can't start now, and why it didn't. */
  readonly readAgain: {
    readonly run: () => void;
    readonly ready: boolean;
    readonly error: string | undefined;
  };
}) {
  const { image, result, entries } = listed;
  const kept = keptWhole(image, shown);
  const canStep = (by: -1 | 1) =>
    position !== undefined && position.index + by >= 0 && position.index + by < position.of;
  const step = (by: -1 | 1) => {
    if (canStep(by)) onStep(by);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-5xl"
        onKeyDown={(event) => {
          if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          step(event.key === "ArrowLeft" ? -1 : 1);
        }}
      >
        <DialogHeader className="flex-row items-center gap-2 pr-8">
          <DialogTitle className="min-w-0 truncate font-mono text-sm">{image}</DialogTitle>
          {position && (
            <span className="ml-auto text-sm text-muted-foreground tabular-nums">
              {number(position.index + 1)} of {number(position.of)}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className={position ? undefined : "ml-auto"}
            title="Reads this image again from scratch. Each text keeps its English, which is flagged for a look where the text reads differently now, and a text you corrected keeps the correction while it reads as before."
            disabled={locked || !readAgain.ready}
            onClick={readAgain.run}
          >
            Read again
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            title="Previous image (Alt+←)"
            aria-label="Previous image"
            disabled={!canStep(-1)}
            onClick={() => step(-1)}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            title="Next image (Alt+→)"
            aria-label="Next image"
            disabled={!canStep(1)}
            onClick={() => step(1)}
          >
            <ChevronRightIcon />
          </Button>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-auto">
          {readAgain.error && <p className="text-sm text-destructive">{readAgain.error}</p>}
          <Field orientation="horizontal">
            <Checkbox
              id="show-unchanged"
              checked={kept}
              disabled={locked}
              onCheckedChange={onKeepWhole}
            />
            <FieldLabel htmlFor="show-unchanged">Show this image unchanged</FieldLabel>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <figure className="flex flex-col gap-1">
              <OriginalImage game={game} image={image} result={result} />
              <figcaption className="text-xs text-muted-foreground">Original</figcaption>
            </figure>
            <figure className="flex flex-col gap-1">
              <InGameImage
                key={image}
                game={game}
                image={image}
                result={result}
                series={series}
                shown={shown}
                className="h-auto max-w-full self-start"
              />
              <figcaption className="text-xs text-muted-foreground">In the game</figcaption>
            </figure>
          </div>
          <div className="flex flex-col">
            {entries.map((entry) => (
              <ImageText
                key={entry.id}
                entry={entry}
                error={errors.get(`entry:${entry.id}`) ?? errors.get(`keep:${entry.id}`)}
                textError={errors.get(`text:${entry.id}`)}
                locked={locked}
                onChange={(change, delay) => onChange(entry, change, delay)}
              />
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OriginalImage({
  game,
  image,
  result,
}: {
  readonly game: Game;
  readonly image: string;
  readonly result: ImageResult;
}) {
  const [loaded, setLoaded] = useState<{ readonly image: string; readonly src: string }>();
  useEffect(() => {
    let current = true;
    // The image beside it says why it couldn't load.
    void imageAssets(game, image, result).then(
      ({ original }) => current && setLoaded({ image, src: original.src }),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [game, image, result]);
  const src = loaded?.image === image ? loaded.src : undefined;
  return src ? (
    <img src={src} alt={`Original ${image}`} className="h-auto max-w-full self-start" />
  ) : (
    <div className="aspect-video w-full rounded bg-muted" />
  );
}

/** How long typing pauses before the text saves. */
const typingPause = 600;

/**
 * The text read in the image, a form to correct what the reader got wrong, and, once corrected,
 * what was read to go back to.
 */
function SourceText({
  entry,
  error,
  locked,
  onCorrect,
}: {
  readonly entry: Entry;
  readonly error: string | undefined;
  readonly locked: boolean;
  readonly onCorrect: (text: string) => void;
}) {
  const [typed, setTyped] = useState<string>();
  if (typed === undefined)
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-start gap-1">
          <p className="min-w-0 flex-1 text-sm break-words whitespace-pre-wrap">{entry.source}</p>
          <Button
            variant="ghost"
            size="icon-xs"
            title="Correct the text where the image was misread"
            aria-label={`Correct ${entry.source}`}
            disabled={locked}
            onClick={() => setTyped(entry.source)}
          >
            <PencilIcon />
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {entry.readerText !== undefined && (
          <p className="text-sm text-muted-foreground">
            You corrected it. The image reader read{" "}
            <span className="text-foreground">{entry.readerText}</span>{" "}
            <Button
              variant="link"
              size="xs"
              disabled={locked}
              onClick={() => onCorrect(entry.readerText ?? entry.source)}
            >
              Use it
            </Button>
          </p>
        )}
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Textarea
        className="min-h-9"
        value={typed}
        disabled={locked}
        aria-label={`Text in the image for ${entry.source}`}
        onChange={(event) => setTyped(event.target.value)}
      />
      <p className="text-sm text-muted-foreground">
        Saving clears English a translation run gave, so the next run translates the corrected text.
        English you typed stays.
      </p>
      <div className="flex gap-2">
        <Button
          size="xs"
          disabled={locked || typed.trim() === ""}
          onClick={() => {
            onCorrect(typed);
            setTyped(undefined);
          }}
        >
          Save
        </Button>
        <Button variant="outline" size="xs" onClick={() => setTyped(undefined)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ImageText({
  entry,
  error,
  textError,
  locked,
  onChange,
}: {
  readonly entry: Entry;
  readonly error: string | undefined;
  readonly textError: string | undefined;
  readonly locked: boolean;
  readonly onChange: (change: TextChange, delay: number) => void;
}) {
  const translation = entryTranslation(entry);
  const { guess } = entry.translation;
  const choice = !guess
    ? undefined
    : guess.long !== undefined && translation === guess.value
      ? { says: "Shortened to fit the image. The first answer was", other: guess.long }
      : guess.long !== undefined && translation === guess.long
        ? { says: "Too long for the image. The shorter answer is", other: guess.value }
        : translation !== guess.value
          ? { says: guess.run ? "The run's answer is" : "RPGTL's English is", other: guess.value }
          : undefined;
  const keepId = `keep-artwork-${entry.id}`;
  return (
    <div className="grid grid-cols-2 gap-4 border-t py-3" role="group" aria-label={entry.source}>
      <SourceText
        entry={entry}
        error={textError}
        locked={locked}
        onCorrect={(text) => onChange({ text }, 0)}
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <Textarea
          className="min-h-9"
          value={translation}
          disabled={locked}
          placeholder="Translation"
          aria-label={`English for ${entry.source}`}
          aria-invalid={error !== undefined || undefined}
          onChange={(event) => onChange({ translation: event.target.value }, typingPause)}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Field orientation="horizontal">
          <Checkbox
            id={keepId}
            checked={entry.keepOriginal === true}
            disabled={locked}
            onCheckedChange={(keepOriginal) => onChange({ keepOriginal }, 0)}
          />
          <FieldLabel htmlFor={keepId}>Keep original artwork</FieldLabel>
        </Field>
        {choice && (
          <p className="text-sm text-muted-foreground">
            {choice.says} <span className="text-foreground">{choice.other}</span>{" "}
            <Button
              variant="link"
              size="xs"
              disabled={locked}
              onClick={() => onChange({ translation: choice.other }, 0)}
            >
              Use
            </Button>
          </p>
        )}
      </div>
    </div>
  );
}
