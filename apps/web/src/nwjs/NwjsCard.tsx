import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { failureMessage } from "../app/failure.ts";
import { megabytes } from "../translation/counts.ts";
import { download, nwjsStatus } from "./atoms.ts";
import { NwjsDownloading } from "./NwjsDownloading.tsx";

/** Whether NW.js, which Play starts games in, is downloaded, and a way to download it. */
export function NwjsCard() {
  const status = useAtomValue(nwjsStatus);
  const start = useAtomSet(download, { mode: "promiseExit" });
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);

  const fetchNwjs = async () => {
    setError(undefined);
    setSending(true);
    const exit = await start({});
    setSending(false);
    if (Exit.isFailure(exit)) setError(failureMessage(exit.cause));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>NW.js</CardTitle>
        <CardDescription>
          Play runs games in NW.js.
          {AsyncResult.isSuccess(status) && ` Kept in ${status.value.folder}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {AsyncResult.match(status, {
          onInitial: () => <Skeleton className="h-8" />,
          onFailure: ({ cause }) => <p className="text-destructive">{failureMessage(cause)}</p>,
          onSuccess: ({ value }) =>
            value.phase._tag === "Ready" ? (
              <p>NW.js {value.version} is downloaded.</p>
            ) : value.phase._tag === "Downloading" ? (
              <NwjsDownloading
                version={value.version}
                received={value.phase.received}
                size={value.size}
              />
            ) : (
              <>
                <p>
                  NW.js {value.version} isn't downloaded yet. It is a one-time download of{" "}
                  {megabytes(value.size)} MB; Play also offers it.
                </p>
                {value.phase.error && (
                  <p className="text-destructive">The last download failed: {value.phase.error}</p>
                )}
                <Button className="self-start" disabled={sending} onClick={fetchNwjs}>
                  Download NW.js
                </Button>
              </>
            ),
        })}
        {error && <p className="text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
