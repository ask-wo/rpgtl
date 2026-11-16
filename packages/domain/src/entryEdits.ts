import { EntryProblem, entryProblem, type Catalog, type Entry } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { type EntryText, entryTexts, withTexts, withTextOf } from "./catalog.ts";
import { translationInUse, withUserTranslation } from "./inUse.ts";
import { isImageText } from "./location.ts";
import { keepsControlCodes } from "./controlCodes.ts";

/**
 * What the user changed on an entry on the Text or Images page: its text's English, an image's
 * text where the reader got it wrong, or whether it is left untranslated. An absent field stays as
 * saved.
 */
export interface EntryEdit {
  readonly id: string;
  readonly userTranslation?: string;
  /** An image's text as the user corrected it; what was read undoes the correction. */
  readonly source?: string;
  readonly isLeftUntranslated?: boolean;
}

/** An edited translation that can't be saved, and why. */
export class EntryEditInvalid extends Schema.TaggedError<EntryEditInvalid>()("EntryEditInvalid", {
  id: Schema.String,
  problem: EntryProblem,
}) {
  override get message() {
    return entryProblem(this.problem);
  }
}

/**
 * The catalog with the user's edits. English other than the text's other translations is the
 * user's, and one of those restores it; a rejected answer stays while the text has no English. A
 * corrected image text moves the entry to the text of its new source, which gets the English the
 * user typed for the old one unless it has its own, and applies before the English, which must
 * keep its control codes.
 */
export function withEntryEdits(
  catalog: Catalog,
  edits: ReadonlyArray<EntryEdit>,
): Result.Result<Catalog, EntryEditInvalid> {
  const known = new Map(entryTexts(catalog).map((entry) => [entry.id, entry]));
  const edited = new Map<string, EntryEdit>();
  for (const edit of edits) {
    const { id } = edit;
    if (!known.has(id)) return Result.fail(new EntryEditInvalid({ id, problem: "unknownEntry" }));
    edited.set(id, { ...edited.get(id), ...edit });
  }
  const problem = (
    entry: EntryText,
    { userTranslation, source }: EntryEdit,
  ): EntryProblem | undefined => {
    if (source !== undefined && !isImageText(entry)) return "notImageText";
    if (source?.trim() === "") return "emptyText";
    if (userTranslation && !keepsControlCodes(source?.trim() ?? entry.source, userTranslation))
      return "controlCodes";
    return undefined;
  };
  for (const [id, edit] of edited) {
    const entry = known.get(id);
    const found = entry && problem(entry, edit);
    if (found) return Result.fail(new EntryEditInvalid({ id, problem: found }));
  }
  let next: Catalog = catalog;
  const entries = catalog.entries.map((saved) => {
    const edit = edited.get(saved.id);
    if (edit === undefined) return saved;
    const kept: Entry =
      edit.isLeftUntranslated === undefined
        ? saved
        : edit.isLeftUntranslated
          ? { ...saved, isLeftUntranslated: true }
          : Struct.omit(saved, ["isLeftUntranslated"]);
    const source = edit.source?.trim();
    if (source === undefined) return kept;
    const old = known.get(saved.id);
    const moved = withTextOf(next, { source, isInImage: true });
    next = moved.catalog;
    const userTranslation = old?.userTranslation;
    if (userTranslation !== undefined)
      next = withTexts(next, (text) =>
        text.id === moved.id && !translationInUse(text) ? { ...text, userTranslation } : text,
      );
    return { ...kept, textId: moved.id };
  });
  next = { ...next, entries };
  const typed = new Map<number, string>();
  for (const [id, edit] of edited) {
    const entry = next.entries.find((each) => each.id === id);
    if (entry && edit.userTranslation !== undefined) typed.set(entry.textId, edit.userTranslation);
  }
  return Result.succeed(
    withTexts(next, (text) => {
      const translation = typed.get(text.id);
      if (translation === undefined || translation === translationInUse(text)) return text;
      const { rejectedTranslation, rejectionReason, ...rest } = text;
      return {
        ...withUserTranslation(rest, translation),
        ...(!translation && rejectedTranslation !== undefined && { rejectedTranslation }),
        ...(!translation && rejectionReason !== undefined && { rejectionReason }),
      };
    }),
  );
}
