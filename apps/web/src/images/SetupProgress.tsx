import type { ImageReaderSetupStatus } from "@rpgtl/contracts";
import { Progress } from "~/components/ui/progress";
import { type SettingUp, setupLabel, setupProgress } from "./readerSetup.ts";

/**
 * How far setting up the image reader got, with a bar, as Settings and every page's run bar show
 * it. `after` says what follows, such as reading.
 */
export function SetupProgress({
  status,
  after,
}: {
  readonly status: ImageReaderSetupStatus & { readonly phase: SettingUp };
  readonly after?: string;
}) {
  const { value, working } = setupProgress(status.phase);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <p className="text-sm">
        <span className="font-medium">
          {/* Only the Korean recognizer is set up after the reader. */}
          {status.ready ? "Adding the Korean text model" : "Setting up the image reader"}
        </span>
        {` · ${setupLabel(status.phase)}`}
        <span className="text-muted-foreground">
          {" · takes a few minutes"}
          {after && `, then ${after}`}
        </span>
      </p>
      <Progress value={value} working={working} aria-label="Image reader setup" />
    </div>
  );
}
