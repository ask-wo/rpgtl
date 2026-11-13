import type { Engine } from "@rpgtl/contracts";
import type { Placed } from "../../location.ts";

/** A part of an XP database name in square brackets or braces. */
export const nameTagPattern = /\[[^\]]*\]|\{[^}]*\}/g;

/**
 * Whether the entry is an XP database name, whose parts in brackets and braces stay as they are.
 * XP games commonly draw names without those parts, and their scripts read the tags in them
 * (`[GRD]` becomes a number, `[S 10]` sets a speed), so a changed tag changes how the game plays.
 */
export const keepsNameTags = (engine: Engine, { location }: Placed) =>
  engine === "XP" && location?._tag === "RecordField" && location.field === "name";

/** The name without its tags, as the game draws it. */
export const withoutNameTags = (name: string) => name.replace(nameTagPattern, "").trim();
