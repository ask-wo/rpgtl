import { TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { TranslationCard } from "../translation/TranslationCard.tsx";
import { useGame } from "./GameContext.ts";

const tools = [
  {
    key: "F7",
    name: "Map view",
    does: "Shows the current map with its walls and events, and teleports you to any tile or map.",
  },
  {
    key: "F8",
    name: "Game panel (WIP)",
    does: "Changes gold, items, stats, variables and switches; turns off encounters, walks through walls, saves anywhere. Currently unfinished.",
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
      {game.missingImages.length > 0 && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>
            {game.missingImages.length === 1
              ? "1 image the game asks for isn't in its folder. Replaced with a blank image."
              : `${game.missingImages.length} images the game asks for aren't in its folder. Replaced with blank images.`}
          </AlertTitle>
          <AlertDescription>
            <ul className="list-inside list-disc">
              {game.missingImages.map((image) => (
                <li key={image.path}>
                  <code>{image.path}</code>, asked for in {image.files.join(", ")}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
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
      <TranslationCard />
    </div>
  );
}
