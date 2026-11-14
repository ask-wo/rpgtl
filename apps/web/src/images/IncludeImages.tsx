import { useAtom, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { imageResults, imagesInExports } from "./atoms.ts";

/** The choice of whether exports carry the images, shown once the game has read images. */
export function IncludeImages({ gameId }: { gameId: string }) {
  const read = AsyncResult.getOrElse(useAtomValue(imageResults(gameId)), () => undefined);
  const [included, include] = useAtom(imagesInExports);
  if (!read || Object.keys(read.images).length === 0) return null;
  return (
    <Label className="text-xs font-normal">
      <Checkbox checked={included} onCheckedChange={include} />
      Include images
    </Label>
  );
}
