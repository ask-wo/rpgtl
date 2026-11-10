import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ImageReaderSetupStatus } from "@rpgtl/contracts";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { failureMessage } from "../app/failure.ts";
import {
  imageReaderStatus,
  removeImageReader,
  removeKoreanModel,
  setUpImageReader,
} from "./atoms.ts";
import { gigabytes, megabytes } from "../translation/counts.ts";
import { runsOn } from "./readerSetup.ts";
import { SetupProgress } from "./SetupProgress.tsx";

/** Whether the image reader is set up, and ways to set it up and remove it. */
export function ImageReaderCard() {
  const status = useAtomValue(imageReaderStatus);
  const setUp = useAtomSet(setUpImageReader, { mode: "promiseExit" });
  const remove = useAtomSet(removeImageReader, { mode: "promiseExit" });
  const removeKorean = useAtomSet(removeKoreanModel, { mode: "promiseExit" });
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);

  const asked = async (
    request: () => Promise<Exit.Exit<unknown, { readonly message: string }>>,
  ) => {
    setError(undefined);
    setSending(true);
    const exit = await request();
    setSending(false);
    if (Exit.isFailure(exit)) setError(failureMessage(exit.cause));
  };

  const installed = (value: ImageReaderSetupStatus) =>
    value.phase._tag === "SettingUp" ? (
      <SetupProgress status={{ ...value, phase: value.phase }} />
    ) : value.phase._tag === "Removing" ? (
      <p className="flex items-center gap-2">
        <Spinner />
        Deleting the image reader's files…
      </p>
    ) : value.ready ? (
      <>
        <p>The image reader is set up and runs on {runsOn[value.device]}.</p>
        {value.korean.ready ? (
          <>
            <p>It has the model for Korean text.</p>
            <Button
              variant="outline"
              className="self-start"
              disabled={sending}
              onClick={() => asked(() => removeKorean({}))}
            >
              Remove the Korean model
            </Button>
          </>
        ) : (
          <>
            <p>
              Korean games need a model of their own, which reading their images offers to add.
              Adding it downloads about {megabytes(value.korean.download)} MB.
            </p>
            {value.phase.error && (
              <p className="text-destructive">Adding it failed: {value.phase.error}</p>
            )}
            <Button
              variant="outline"
              className="self-start"
              disabled={sending}
              onClick={() => asked(() => setUp({ payload: { korean: true } }))}
            >
              Add the Korean model
            </Button>
          </>
        )}
        <Button
          variant="outline"
          className="self-start"
          disabled={sending}
          onClick={() => asked(() => remove({}))}
        >
          Remove the image reader
        </Button>
      </>
    ) : (
      <>
        <p>
          Not set up yet. Setting it up downloads about {gigabytes(value.download)} GB once and runs
          on {runsOn[value.device]}.
        </p>
        {value.note && <p className="text-muted-foreground">{value.note}</p>}
        {value.phase.error && (
          <p className="text-destructive">Setting up failed: {value.phase.error}</p>
        )}
        <div className="flex gap-2">
          <Button
            disabled={sending}
            onClick={() => asked(() => setUp({ payload: { korean: false } }))}
          >
            {value.onDisk ? "Set up again" : "Set up the image reader"}
          </Button>
          {value.onDisk && (
            <Button variant="outline" disabled={sending} onClick={() => asked(() => remove({}))}>
              Delete what setting up left
            </Button>
          )}
        </div>
      </>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Image reader</CardTitle>
        <CardDescription>
          Reads text locally with PaddleOCR and erases it with LaMa.
          {AsyncResult.isSuccess(status) && ` Kept in ${status.value.folder}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {AsyncResult.match(status, {
          onInitial: () => <Skeleton className="h-8" />,
          onFailure: ({ cause }) => <p className="text-destructive">{failureMessage(cause)}</p>,
          onSuccess: ({ value }) =>
            value.external ? (
              <p>
                RPGTL uses the image reader at {value.external}, started outside RPGTL
                (RPGTL_IMAGE_READER).
              </p>
            ) : (
              installed(value)
            ),
        })}
        {error && <p className="text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
