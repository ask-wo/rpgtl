import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { number } from "../translation/counts.ts";
import type { Area } from "./search.ts";

interface TreePlace {
  /** The place's key, as the address keeps it. */
  readonly key: string;
  readonly label: string;
  /** How many of the place's entries the filter and search show. */
  readonly count: number;
}

export interface TreeArea {
  readonly area: Area;
  readonly count: number;
  readonly places: ReadonlyArray<TreePlace>;
}

/** What the page shows: every place, one area, or one place. */
export type Selection =
  | { readonly kind: "all" }
  | { readonly kind: "area"; readonly area: Area }
  | { readonly kind: "place"; readonly place: string };

/**
 * The places of the game's text by area, each with how many entries the filter and search show.
 * While either narrows the text, places with none of it are left out.
 */
export function FileTree({
  total,
  tree,
  narrowed,
  selected,
  onSelect,
}: {
  readonly total: number;
  readonly tree: ReadonlyArray<TreeArea>;
  readonly narrowed: boolean;
  readonly selected: Selection;
  readonly onSelect: (selection: Selection) => void;
}) {
  const [closed, setClosed] = useState<ReadonlySet<Area>>(new Set());
  return (
    <nav aria-label="Text files" className="flex flex-col py-2 text-sm">
      <Row
        label="All files"
        count={total}
        current={selected.kind === "all"}
        onClick={() => onSelect({ kind: "all" })}
      />
      {tree.map(({ area, count, places }) => {
        const open = !closed.has(area);
        const listed = narrowed ? places.filter((place) => place.count > 0) : places;
        return (
          <div key={area}>
            <div className="flex items-center">
              <button
                type="button"
                className="ml-1 rounded p-1 text-muted-foreground hover:bg-accent"
                aria-label={`${open ? "Hide" : "Show"} the files in ${area}`}
                aria-expanded={open}
                onClick={() => {
                  const next = new Set(closed);
                  if (open) next.add(area);
                  else next.delete(area);
                  setClosed(next);
                }}
              >
                <ChevronRightIcon
                  className={cn("size-3.5 transition-transform", open && "rotate-90")}
                />
              </button>
              <Row
                label={area}
                count={count}
                current={selected.kind === "area" && selected.area === area}
                onClick={() => onSelect({ kind: "area", area })}
                className="pl-1 font-medium"
              />
            </div>
            {open &&
              listed.map(({ key, label, count: shown }) => (
                <Row
                  key={key}
                  label={label}
                  count={shown}
                  current={selected.kind === "place" && selected.place === key}
                  onClick={() => onSelect({ kind: "place", place: key })}
                  className="pl-9"
                />
              ))}
          </div>
        );
      })}
    </nav>
  );
}

function Row({
  label,
  count,
  current,
  onClick,
  className,
}: {
  readonly label: string;
  readonly count: number;
  readonly current: boolean;
  readonly onClick: () => void;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      aria-current={current || undefined}
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 px-3 py-1 text-left hover:bg-accent aria-[current]:bg-accent",
        className,
      )}
    >
      <span className="truncate">{label}</span>
      <span className="ml-auto text-xs text-muted-foreground tabular-nums">{number(count)}</span>
    </button>
  );
}
