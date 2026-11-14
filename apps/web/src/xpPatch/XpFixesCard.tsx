import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { failureMessage } from "../app/failure.ts";
import { useGame } from "../games/GameContext.ts";
import { fixesKey, setFix, xpFixes } from "./atoms.ts";

/**
 * The XP game's fixes, each with a switch; nothing when it has none. A fix applies from the
 * game's next start and in the next exported patch.
 */
export function XpFixesCard() {
  const game = useGame();
  const fixes = AsyncResult.getOrElse(useAtomValue(xpFixes(game.id)), () => []);
  const set = useAtomSet(setFix, { mode: "promiseExit" });
  const [error, setError] = useState<string>();
  if (fixes.length === 0) return null;

  const change = async (name: string, on: boolean) => {
    setError(undefined);
    const exit = await set({
      payload: { id: game.id, name, on },
      reactivityKeys: fixesKey(game.id),
    });
    if (Exit.isFailure(exit)) setError(failureMessage(exit.cause));
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Fixes</CardTitle>
        <CardDescription>
          Scripts that fix bugs in the game. Changes apply from the game's next start.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {fixes.map((fix) => (
          <div key={fix.name} className="flex items-start gap-2">
            <Switch
              id={`fix-${fix.name}`}
              checked={fix.on}
              onCheckedChange={(on) => void change(fix.name, on)}
            />
            <Label htmlFor={`fix-${fix.name}`} className="flex flex-col items-start gap-0.5">
              <span>{fix.name}</span>
              {fix.description && (
                <span className="font-normal text-muted-foreground">{fix.description}</span>
              )}
            </Label>
          </div>
        ))}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
