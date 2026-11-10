import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "~/components/ui/field";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { failureMessage } from "../app/failure.ts";
import { ImageReaderCard } from "../images/ImageReaderCard.tsx";
import { NwjsCard } from "../nwjs/NwjsCard.tsx";
import { useSettings } from "./useSettings.ts";

const display = [
  {
    key: "sharpPixels",
    label: "Sharp pixels",
    does: "Enlarges by whole multiples so pixels stay even.",
  },
  {
    key: "sharpText",
    label: "Sharp text",
    does: "Draws text at your screen's resolution so it stays crisp. Uses more graphics memory.",
  },
] as const;

/** Settings for every game. */
export function SettingsPage() {
  const { settings: saved, save, error } = useSettings();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>Global options</CardTitle>
          <CardDescription>Refreshes on restart or F5.</CardDescription>
        </CardHeader>
        <CardContent>
          {AsyncResult.match(saved, {
            onInitial: () => <Skeleton className="h-16" />,
            onFailure: ({ cause }) => (
              <p className="text-sm text-destructive">{failureMessage(cause)}</p>
            ),
            onSuccess: ({ value }) => (
              <FieldGroup>
                {display.map((option) => (
                  <Field key={option.key} orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor={option.key}>{option.label}</FieldLabel>
                      <FieldDescription>{option.does}</FieldDescription>
                    </FieldContent>
                    <Switch
                      id={option.key}
                      checked={value[option.key]}
                      onCheckedChange={(checked) => save({ ...value, [option.key]: checked })}
                    />
                  </Field>
                ))}
              </FieldGroup>
            ),
          })}
          {error && <p className="pt-3 text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
      <NwjsCard />
      <ImageReaderCard />
    </div>
  );
}
