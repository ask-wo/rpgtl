import { cn } from "cn";
import { Progress } from "~/components/ui/progress";
import { megabytes } from "../translation/counts.ts";

export function ProgramDownloading({
  name,
  version,
  received,
  size,
  className,
}: {
  readonly name: string;
  readonly version: string;
  readonly received: number;
  readonly size: number;
  readonly className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex flex-wrap justify-between gap-x-2">
        <span>
          Downloading {name} {version}
        </span>
        {/* The hidden copy holds the widest count's room, so a growing count never moves the bar. */}
        <span className="grid text-right whitespace-nowrap tabular-nums">
          <span className="invisible col-start-1 row-start-1">
            {megabytes(size)} of {megabytes(size)} MB
          </span>
          <span className="col-start-1 row-start-1">
            {megabytes(received)} of {megabytes(size)} MB
          </span>
        </span>
      </div>
      <Progress value={(received / size) * 100} />
    </div>
  );
}
