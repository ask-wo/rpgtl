import { EntryProblem, entryProblem, type Catalog, type Entry } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { withTranslation } from "./catalog.ts";
import { entryTranslation } from "./guesses.ts";
import { keepsControlCodes } from "./controlCodes.ts";
import { withImageText } from "./imageText.ts";

/**
 * What the user changed on an entry on the Text or Images page: its English, an image's text where
 * the reader got it wrong, or whether an image text keeps its original artwork. An absent field
 * stays as saved.
 */
export interface EntryEdit {
  readonly id: string;
  readonly translation?: string;
  readonly text?: string;
  readonly keepOriginal?: boolean;
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
 * The catalog with the user's edits. English other than the run's guess is the user's, and the
 * guess's own English restores it; a rejected answer stays while the entry has no English. A
 * corrected text applies before the English, which must keep its control codes.
 */
export function withEntryEdits(
  catalog: Catalog,
  edits: ReadonlyArray<EntryEdit>,
): Result.Result<Catalog, EntryEditInvalid> {
  const known = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const edited = new Map<string, EntryEdit>();
  for (const edit of edits) {
    const { id } = edit;
    if (!known.has(id)) return Result.fail(new EntryEditInvalid({ id, problem: "unknownEntry" }));
    edited.set(id, { ...edited.get(id), ...edit });
  }
  const problem = (entry: Entry, { translation, text }: EntryEdit): EntryProblem | undefined => {
    if (text !== undefined && !entry.file.startsWith("img/")) return "notImageText";
    if (text?.trim() === "") return "emptyText";
    if (translation && !keepsControlCodes(text?.trim() ?? entry.source, translation))
      return "controlCodes";
    return undefined;
  };
  for (const entry of catalog.entries) {
    const edit = edited.get(entry.id);
    const found = edit && problem(entry, edit);
    if (found) return Result.fail(new EntryEditInvalid({ id: entry.id, problem: found }));
  }
  const entries = catalog.entries.map((saved) => {
    const edit = edited.get(saved.id);
    if (edit === undefined) return saved;
    const entry = edit.text === undefined ? saved : withImageText(saved, edit.text.trim());
    const kept =
      edit.keepOriginal === undefined
        ? entry
        : edit.keepOriginal
          ? { ...entry, keepOriginal: true }
          : Struct.omit(entry, ["keepOriginal"]);
    const { translation } = edit;
    if (translation === undefined || translation === entryTranslation(entry)) return kept;
    const { suggestion } = entry;
    return {
      ...withTranslation(Struct.omit(kept, ["suggestion"]), translation),
      ...(!translation && suggestion && { suggestion }),
    };
  });
  return Result.succeed({ ...catalog, entries });
}
