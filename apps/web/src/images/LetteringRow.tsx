import type { Catalog, Game, LetteringFont } from "@rpgtl/contracts";
import { letteringFace } from "@rpgtl/game/lettering-fonts";
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
import { ChoiceField } from "../translation/ChoiceField.tsx";
import type { Choice } from "../translation/choices.ts";
import { gameFont } from "./assets.ts";
import type { ShownImages } from "./InGameImage.tsx";
import { entryTranslation } from "@rpgtl/domain";

/** How this game draws the English in its images. */
export interface Lettering {
  readonly imageBold: Catalog["imageBold"];
  readonly imageFont: Catalog["imageFont"];
}

type Weight = NonNullable<Catalog["imageBold"]> | "original";
const weights: ReadonlyArray<Choice<Weight>> = [
  { value: "original", label: "Original weight" },
  { value: "always", label: "Always bold" },
  { value: "never", label: "Never bold" },
];
type Font = LetteringFont | "game";
const fonts: ReadonlyArray<Choice<Font>> = [
  { value: "game", label: "The game's font" },
  { value: "sans", label: "Noto Sans" },
  { value: "serif", label: "Noto Serif" },
];

/**
 * The game's lettering weight and font, a preview of its own short image translations in them, and
 * Clear image text…, which asks first.
 */
export function LetteringRow({
  game,
  shown,
  locked,
  clearing,
  onLettering,
  onClear,
}: {
  readonly game: Game;
  readonly shown: ShownImages;
  readonly locked: boolean;
  readonly clearing: boolean;
  readonly onLettering: (lettering: Lettering) => void;
  readonly onClear: () => void;
}) {
  const [asking, setAsking] = useState(false);
  // A run that takes the game closes the question.
  const [wasLocked, setWasLocked] = useState(locked);
  if (locked !== wasLocked) {
    setWasLocked(locked);
    if (locked) setAsking(false);
  }
  const lettering = { imageBold: shown.imageBold, imageFont: shown.imageFont };
  return (
    <div className="flex flex-wrap items-center gap-3 border-b px-6 py-2">
      <span className="text-sm text-muted-foreground">
        English lettering in this game's images:
      </span>
      <div
        className={`flex gap-2 ${locked ? "opacity-50" : ""}`}
        inert={locked}
        aria-disabled={locked || undefined}
      >
        <div className="w-40">
          <ChoiceField
            id="lettering-weight"
            label="English lettering weight"
            labelHidden
            value={shown.imageBold ?? "original"}
            choices={weights}
            onChoose={(weight) =>
              onLettering({ ...lettering, imageBold: weight === "original" ? undefined : weight })
            }
          />
        </div>
        <div className="w-40">
          <ChoiceField
            id="lettering-font"
            label="English lettering font"
            labelHidden
            value={shown.imageFont ?? "game"}
            choices={fonts}
            onChoose={(font) =>
              onLettering({ ...lettering, imageFont: font === "game" ? undefined : font })
            }
          />
        </div>
      </div>
      <FontPreview game={game} shown={shown} />
      <Button variant="outline" disabled={locked || clearing} onClick={() => setAsking(true)}>
        Clear image text…
      </Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear this game's image text?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the text read in this game's images and its English. Read new images
              reads them again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onClear}>
              Clear image text
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** A few of the game's own short image translations, as the chosen lettering draws them. */
function FontPreview({ game, shown }: { readonly game: Game; readonly shown: ShownImages }) {
  const font = shown.imageFont;
  const [face, setFace] = useState<string>();
  useEffect(() => {
    let current = true;
    if (font) setFace(letteringFace(font));
    else void gameFont(game).then((loaded) => current && setFace(loaded));
    return () => {
      current = false;
    };
  }, [game, font]);
  const words = [
    ...new Set(
      shown.entries
        .filter((entry) => entry.file.startsWith("img/") && !entry.keepOriginal)
        .map((entry) => entryTranslation(entry).trim())
        .filter((text) => text && text.length <= 14 && !text.includes("\n")),
    ),
  ].slice(0, 4);
  const sample = words.length > 0 ? words.join(" · ") : "Level · EXP · Next";
  return (
    <p
      className="flex min-w-48 flex-1 flex-col rounded-md bg-[#2a2733] px-3 py-1 text-lg leading-tight text-[#f5e3c0] *:truncate"
      style={{ fontFamily: face }}
      aria-label="Lettering preview"
    >
      {shown.imageBold !== "always" && <span>{sample}</span>}
      {shown.imageBold !== "never" && <b>{sample}</b>}
    </p>
  );
}
