import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { MissingFile } from "@rpgtl/contracts";
import { engineFeatures } from "@rpgtl/domain";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { TranslationCard } from "../translation/TranslationCard.tsx";
import { playtime } from "./atoms.ts";
import { useGame } from "./GameContext.ts";
import { playtimeText } from "./playtimeText.ts";
import { XpPatchCard } from "../xpPatch/XpPatchCard.tsx";

const tools = [
  {
    key: "F7",
    name: "Map view",
    does: "Shows the current map with its walls and events, and teleports you to any tile or map.",
  },
  {
    key: "F8",
    name: "Game panel (WIP)",
    does: "Changes gold, items, actors, variables and switches; ends battles, changes how you move, saves anywhere. Currently unfinished.",
  },
  {
    key: "F9",
    name: "Fast forward",
    does: "Speeds up dialogue until the next choice or until you can walk again.",
  },
] as const;

/** What a game needs looked at, the tools RPGTL adds to it while it plays, and its translation. */
export function Overview() {
  const game = useGame();
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <Played id={game.id} />
      <MissingFiles
        files={game.missingImages}
        title={(count) =>
          count === 1
            ? "1 image the game asks for isn't in its folder. Replaced with a blank image."
            : `${count} images the game asks for aren't in its folder. Replaced with blank images.`
        }
      />
      <MissingFiles
        files={game.missingAudio ?? []}
        title={(count) =>
          count === 1
            ? "1 sound the game asks for isn't in its folder. It stays silent."
            : `${count} sounds the game asks for aren't in its folder. They stay silent.`
        }
      />
      {game.mediaWarnings.length > 0 && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>NW.js may not play some of this game's sound or video</AlertTitle>
          <AlertDescription>
            <ul className="list-inside list-disc">
              {game.mediaWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {engineFeatures[game.engine].gameScripts && (
        <Card>
          <CardHeader>
            <CardTitle>In-game tools</CardTitle>
            <CardDescription>Press these keys while the game plays.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3">
              {tools.map((tool) => (
                <div key={tool.key} className="contents">
                  <dt>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {tool.key}
                    </kbd>
                  </dt>
                  <dd>
                    <span className="font-medium">{tool.name}.</span>{" "}
                    <span className="text-muted-foreground">{tool.does}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      )}
      {engineFeatures[game.engine].patch && <XpPatchCard />}
      <TranslationCard />
    </div>
  );
}

function Played({ id }: { id: string }) {
  const played = AsyncResult.getOrElse(useAtomValue(playtime(id)), () => null);
  const refresh = useAtomRefresh(playtime(id));
  // The game plays in another tab or in NW.js, so coming back to RPGTL reads the time again.
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  if (!played) return null;
  return <p className="text-sm text-muted-foreground">{playtimeText(played)}</p>;
}

function MissingFiles({
  files,
  title,
}: {
  files: ReadonlyArray<MissingFile>;
  title: (count: number) => string;
}) {
  if (files.length === 0) return null;
  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>{title(files.length)}</AlertTitle>
      <AlertDescription>
        <ul className="list-inside list-disc">
          {files.map((file) => (
            <li key={file.path}>
              <code>{file.path}</code>, asked for in {file.files.join(", ")}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
