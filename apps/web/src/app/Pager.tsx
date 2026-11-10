import { Button } from "~/components/ui/button";
import { number } from "../translation/counts.ts";

export function Pager({
  count,
  page,
  pages,
  turn,
}: {
  /** What the list holds, such as "12 entries". */
  readonly count: string;
  readonly page: number;
  readonly pages: number;
  readonly turn: (page: number) => void;
}) {
  return (
    <div className="flex items-center gap-3 border-t px-6 py-2 text-sm">
      <span className="text-muted-foreground">
        {count} · page {number(page + 1)} of {number(pages)}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="ml-auto"
        disabled={page === 0}
        onClick={() => turn(page - 1)}
      >
        Previous
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={page + 1 >= pages}
        onClick={() => turn(page + 1)}
      >
        Next
      </Button>
    </div>
  );
}
