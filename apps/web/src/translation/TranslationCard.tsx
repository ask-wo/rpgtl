import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Catalog } from "@rpgtl/contracts";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useState } from "react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { FieldLegend, FieldSet } from "~/components/ui/field";
import { Label } from "~/components/ui/label";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { failureMessage } from "../app/failure.ts";
import { activity, gameHeld, runGoing } from "../games/activity.ts";
import { useGame } from "../games/GameContext.ts";
import { useSettings } from "../settings/useSettings.ts";
import { catalog, catalogKey, setTranslate } from "./atoms.ts";
import { catalogCounts, counted, number } from "./counts.ts";
import { usesLocalModels } from "./choices.ts";
import { ImageReadingFields } from "./ImageReadingFields.tsx";
import { LanguageField } from "./LanguageField.tsx";
import { ScriptsField } from "./ScriptsField.tsx";
import { LocalModelFields } from "./LocalModelFields.tsx";
import { TranslationActions } from "./TranslationActions.tsx";
import { TranslatorFields } from "./TranslatorFields.tsx";
import { entryTranslation, isScriptText } from "@rpgtl/domain";

/** The game's translation switch and, while it is on, what the game's translation holds. */
export function TranslationCard() {
  const game = useGame();
  const saved = useAtomValue(catalog(game.id));
  const toggle = useAtomSet(setTranslate, { mode: "promiseExit" });
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string>();

  const change = async (on: boolean) => {
    setError(undefined);
    setSwitching(true);
    const exit = await toggle({
      payload: { id: game.id, on },
      reactivityKeys: catalogKey(game.id),
    });
    setSwitching(false);
    if (Exit.isFailure(exit)) setError(failureMessage(exit.cause));
  };

  const value = AsyncResult.getOrElse(saved, () => undefined);
  const on = value !== undefined && value.translate;
  const now = AsyncResult.getOrElse(useAtomValue(activity(game.id)), () => undefined);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Translation</CardTitle>
        <CardDescription>
          {value === undefined ? null : on ? (
            "Applies from the game's next start or F5."
          ) : (
            <OffLine saved={value} />
          )}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Label htmlFor="translate-game">Translate this game</Label>
          <Switch
            id="translate-game"
            checked={on}
            disabled={value === undefined || switching || gameHeld(now)}
            onCheckedChange={change}
          />
        </CardAction>
      </CardHeader>
      {(on || !AsyncResult.isSuccess(saved) || error) && (
        <CardContent className="flex flex-col gap-4">
          {AsyncResult.match(saved, {
            onInitial: () => <Skeleton className="h-10" />,
            onFailure: ({ cause }) => (
              <p className="text-sm text-destructive">{failureMessage(cause)}</p>
            ),
            onSuccess: ({ value: loaded }) =>
              on ? (
                <>
                  <Counts saved={loaded} />
                  <LanguageField saved={loaded} locked={gameHeld(now)} />
                  {loaded.entries.some(isScriptText) && (
                    <ScriptsField saved={loaded} locked={gameHeld(now)} />
                  )}
                  <TranslationActions gameId={game.id} locked={gameHeld(now)} />
                  <Separator />
                  <SharedSettings locked={runGoing(now)} />
                </>
              ) : null,
          })}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      )}
    </Card>
  );
}

function OffLine({ saved }: { readonly saved: Catalog }) {
  const translated = saved.entries.filter((entry) => entryTranslation(entry)).length;
  if (translated === 0) return "Switch on to translate or import.";
  return `Off: the game plays its original text. ${counted(translated, "translation is", "translations are")} kept.`;
}

function Counts({ saved }: { readonly saved: Catalog }) {
  const { text, images, glossary } = catalogCounts(saved);
  return (
    <ul className="flex flex-col gap-1 text-sm">
      <li>
        {number(text.translated)} of {number(text.all)} text entries translated
      </li>
      {images.all > 0 && (
        <li>
          {number(images.translated)} of {number(images.all)} entries in{" "}
          {counted(images.files, "image", "images")} translated
        </li>
      )}
      <li>{counted(glossary, "glossary term", "glossary terms")}</li>
    </ul>
  );
}

/** The translator and image reading settings, which every game shares; locked while a run goes. */
function SharedSettings({ locked }: { readonly locked: boolean }) {
  const { settings: saved, save, error } = useSettings();
  return AsyncResult.match(saved, {
    onInitial: () => <Skeleton className="h-40" />,
    onFailure: ({ cause }) => <p className="text-sm text-destructive">{failureMessage(cause)}</p>,
    onSuccess: ({ value }) => (
      <div className="flex flex-col gap-6 @container">
        {locked && (
          <p className="text-sm text-muted-foreground">
            A run is going: stop it to change these settings.
          </p>
        )}
        <div
          inert={locked}
          aria-disabled={locked}
          className="grid items-start gap-8 aria-disabled:opacity-60 @3xl:grid-cols-[3fr_2fr]"
        >
          <FieldSet>
            <FieldLegend>Machine translation</FieldLegend>
            <TranslatorFields settings={value} save={save} />
            {usesLocalModels(value) && (
              <>
                <Separator />
                <FieldSet>
                  <FieldLegend variant="label">Local models</FieldLegend>
                  <LocalModelFields settings={value} save={save} />
                </FieldSet>
              </>
            )}
          </FieldSet>
          <FieldSet>
            <FieldLegend>Image translation</FieldLegend>
            <ImageReadingFields settings={value} save={save} />
          </FieldSet>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    ),
  });
}
