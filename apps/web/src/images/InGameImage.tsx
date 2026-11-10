import {
  type Catalog,
  type Game,
  type ImageReadResults,
  type ImageResult,
  ImageTextHint,
} from "@rpgtl/contracts";
import { imageTextHints, seriesOf } from "@rpgtl/domain";
import { drawImageText } from "@rpgtl/game/lettering";
import { letteringFace } from "@rpgtl/game/lettering-fonts";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";
import { gameFont, imageAssets } from "./assets.ts";

/** What decides how an image looks in the game, saved or as typed on the page. */
export type ShownImages = Pick<Catalog, "entries" | "imageBold" | "imageFont" | "unchangedImages">;

const decodeHint = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.NullOr(ImageTextHint)));

/** The results of the other images of `image`'s series, whose English takes one size with its own. */
export const seriesResults = (results: ImageReadResults, image: string) =>
  Object.fromEntries(
    seriesOf(image, Object.keys(results.images)).flatMap((other) => {
      const result = results.images[other];
      return result ? [[other, result] as const] : [];
    }),
  );

/**
 * The image as the game will show it: the original, with the English drawn over its erased text.
 * It draws once it comes into view, and again when what it shows changes.
 */
export function InGameImage({
  game,
  image,
  result,
  series = {},
  shown,
  className,
}: {
  readonly game: Game;
  readonly image: string;
  readonly result: ImageResult;
  /** The results of the other images of its series (`seriesResults`). */
  readonly series?: Readonly<Record<string, ImageResult>>;
  readonly shown: ShownImages;
  readonly className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [seen, setSeen] = useState(false);
  // As text, so the drawing starts again only when what it draws changes.
  const drawn = JSON.stringify(
    imageTextHints({ version: 1, images: { ...series, [image]: result } }, shown, (file) => file)[
      image
    ] ?? null,
  );
  // An error shows only beside the drawing that failed.
  const [failed, setFailed] = useState<{
    readonly image: string;
    readonly drawn: string;
    readonly message: string;
  }>();
  const error = failed?.image === image && failed.drawn === drawn ? failed.message : undefined;

  useEffect(() => {
    const target = canvas.current;
    if (!target || seen) return;
    const watcher = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    watcher.observe(target);
    return () => watcher.disconnect();
  }, [seen]);

  useEffect(() => {
    const target = canvas.current;
    if (!target || !seen) return;
    const hint = decodeHint(drawn);
    let current = true;
    void (async () => {
      const [{ original, erased }, face] = await Promise.all([
        imageAssets(game, image, result),
        hint?.font ? letteringFace(hint.font) : gameFont(game),
      ]);
      if (hint?.font)
        await Promise.all(
          ["", "bold "].map((weight) => document.fonts.load(`${weight}20px ${face}`, "A")),
        );
      if (!current) return;
      target.width = original.naturalWidth;
      target.height = original.naturalHeight;
      const context = target.getContext("2d");
      if (!context) return;
      context.drawImage(original, 0, 0);
      if (hint && erased) drawImageText(context, erased, hint.blocks, face, hint.series);
      setFailed(undefined);
    })().catch((cause: unknown) => {
      if (!current) return;
      target.width = 0;
      setFailed({ image, drawn, message: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => {
      current = false;
    };
  }, [game, image, result, seen, drawn]);

  return (
    <>
      <canvas
        ref={canvas}
        className={className}
        role="img"
        aria-label={`${image} as the game shows it`}
      />
      {error && <span className="text-xs text-destructive">{error}</span>}
    </>
  );
}
