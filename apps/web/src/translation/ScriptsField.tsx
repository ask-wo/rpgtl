import { useAtomSet } from "@effect/atom-react";
import type { Catalog } from "@rpgtl/contracts";
import * as Exit from "effect/Exit";
import { useState } from "react";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { failureMessage } from "../app/failure.ts";
import { catalogKey, setOriginalScripts } from "./atoms.ts";

/** Whether an XP game plays with the English of its scripts' strings. */
export function ScriptsField({
  saved,
  locked,
}: {
  readonly saved: Catalog;
  readonly locked: boolean;
}) {
  const set = useAtomSet(setOriginalScripts, { mode: "promiseExit" });
  const [error, setError] = useState<string>();
  const change = async (on: boolean) => {
    setError(undefined);
    const exit = await set({
      payload: { id: saved.game.id, on: !on },
      reactivityKeys: catalogKey(saved.game.id),
    });
    if (Exit.isFailure(exit)) setError(failureMessage(exit.cause));
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Switch
          id="translate-scripts"
          checked={!saved.originalScripts}
          disabled={locked}
          onCheckedChange={change}
        />
        <Label htmlFor="translate-scripts">Translate script text</Label>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
