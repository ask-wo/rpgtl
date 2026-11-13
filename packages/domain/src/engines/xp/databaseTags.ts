import type { Engine } from "@rpgtl/contracts";
import type { Placed } from "../../location.ts";

/** A tag in an XP database name or description: a part in square brackets or braces, or a `|`. */
export const tagPattern = /\[[^\]]*\]|\{[^}]*\}|\|/g;

/**
 * Whether the entry is an XP database name or description, whose tags stay as they are. XP games
 * commonly draw these without their tags in brackets and braces, and their scripts read them
 * (`[GRD]` becomes a number, `[S 10]` sets a speed), so a changed tag changes how the game plays.
 * Some help scripts break a description's line at its `|`.
 */
export const keepsTags = (engine: Engine, { location }: Placed) =>
  engine === "XP" &&
  location?._tag === "RecordField" &&
  (location.field === "name" || location.field === "description");

/** The text without its tags. */
export const withoutTags = (text: string) => text.replace(tagPattern, "").trim();
