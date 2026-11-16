import type { Catalog, Entry, Operation, Text } from "@rpgtl/contracts";
import { splitVersion } from "./gameIdentity.ts";
import { cleared, isUserTranslation, translationInUse } from "./inUse.ts";
import { isImageText } from "./location.ts";

/** An entry with the fields of its text, as checks, applying and runs read it. */
export type EntryText = Entry & Omit<Text, "id">;

/** What reading a game's files gives for each entry, before it has a text. */
export type ReadEntry = Pick<EntryText, "id" | "location" | "source"> &
  Partial<Pick<EntryText, "speaker" | "builtinTranslation">>;

/** The catalog's texts by id. */
export const textsById = ({ texts }: Pick<Catalog, "texts">) =>
  new Map(texts.map((text) => [text.id, text]));

/** Each entry of the catalog with the fields of its text, in the catalog's order. */
export function entryTexts(catalog: Pick<Catalog, "entries" | "texts">): EntryText[] {
  const texts = textsById(catalog);
  return catalog.entries.flatMap((entry) => {
    const text = texts.get(entry.textId);
    return text ? [{ ...text, ...entry }] : [];
  });
}

/** The catalog with the texts that `f` changes, keeping each text `f` gives back unchanged. */
export const withTexts = <C extends Pick<Catalog, "texts">>(
  catalog: C,
  f: (text: Text) => Text,
): C => ({ ...catalog, texts: catalog.texts.map(f) });

/** A text's key: no two of the catalog's texts share one. */
export const textKey = ({
  source,
  speaker,
  isInImage,
}: Pick<Text, "source" | "speaker" | "isInImage">) =>
  JSON.stringify([source, speaker ?? null, isInImage]);

/**
 * The catalog with the text of `key`, added without translations when it has none, and its id. An
 * added text's id is below 0 until it is saved, which gives it one.
 */
export function withTextOf<C extends Pick<Catalog, "texts">>(
  catalog: C,
  key: Pick<Text, "source" | "speaker" | "isInImage">,
): { readonly catalog: C; readonly id: number } {
  const wanted = textKey(key);
  const found = catalog.texts.find((text) => textKey(text) === wanted);
  if (found) return { catalog, id: found.id };
  const id = Math.min(0, ...catalog.texts.map((text) => text.id)) - 1;
  const { source, speaker, isInImage } = key;
  const text: Text = { id, source, isInImage, ...(speaker !== undefined && { speaker }) };
  return { catalog: { ...catalog, texts: [...catalog.texts, text] }, id };
}

/** The English of the game's title in System.json without its version, if it has any. */
export const titleTranslation = (catalog: Pick<Catalog, "entries" | "texts">) => {
  const entry = catalog.entries.find(
    ({ location }) =>
      location._tag === "SystemText" &&
      location.keys.length === 1 &&
      location.keys[0] === "gameTitle",
  );
  const text = entry && textsById(catalog).get(entry.textId);
  return text ? splitVersion(translationInUse(text)).name.trim() || undefined : undefined;
};

/**
 * Whether `entries`, the text of a game folder, belong to the game the catalog was built from: at
 * least half of the catalog's text entries are among them, so a moved copy or an update of the
 * game passes and another game doesn't. Image entries don't count, as the folder isn't read for
 * them.
 */
export function sameGame(
  catalog: Pick<Catalog, "entries">,
  entries: ReadonlyArray<Pick<Entry, "id">>,
) {
  const found = new Set(entries.map((entry) => entry.id));
  const text = catalog.entries.filter((entry) => !isImageText(entry));
  return text.filter((entry) => found.has(entry.id)).length * 2 >= text.length;
}

/**
 * The catalog with the translations that runs gave the texts of these entries cleared,
 * so the next run translates them again; translations the user typed stay.
 */
export function withTranslationsCleared(catalog: Catalog, ids: ReadonlyArray<string>) {
  const of = new Set(ids);
  const wanted = new Set(
    catalog.entries.filter((entry) => of.has(entry.id)).map((entry) => entry.textId),
  );
  const clears = (text: Text) =>
    wanted.has(text.id) && !isUserTranslation(text) && translationInUse(text) !== "";
  return {
    cleared: catalog.texts.filter(clears).length,
    catalog: withTexts(catalog, (text) => (clears(text) ? cleared(text) : text)),
  };
}

/** The runs of `runs` that one of `items` names, so a run none of them names any more is dropped. */
export const namedRuns = <R>(
  items: Iterable<{ readonly run?: string }>,
  runs: Readonly<Record<string, R>> = {},
): { readonly runs?: Record<string, R> } => {
  const named = new Set([...items].flatMap((item) => (item.run ? [item.run] : [])));
  const kept = Object.entries(runs).filter(([started]) => named.has(started));
  return kept.length ? { runs: Object.fromEntries(kept) } : {};
};

/** The catalog with every translation and rejected answer cleared. */
export const restoredCatalog = (catalog: Catalog): Catalog =>
  withTexts(catalog, (text) => {
    const { rejectedTranslation: _, rejectionReason: __, ...rest } = text;
    return cleared(rest);
  });

/** The catalog's operations by id. */
export const operationsById = ({ operations }: Pick<Catalog, "operations">) =>
  new Map(operations.map((operation) => [operation.id, operation]));

/** Whether the operation with this id was a run, whose model gave the value it wrote. */
export const byRun = (operations: ReadonlyMap<number, Operation>, id: number | undefined) =>
  id !== undefined && operations.get(id)?.kind === "run";

/** The id of the last run that gave a text or a glossary term its translation, if any did. */
export function lastRun(catalog: Pick<Catalog, "texts" | "glossary" | "operations">) {
  const runs = new Set(
    catalog.operations.filter((operation) => operation.kind === "run").map(({ id }) => id),
  );
  let last: number | undefined;
  for (const { modelOperationId: id } of [...catalog.texts, ...catalog.glossary])
    if (id !== undefined && runs.has(id) && (last === undefined || id > last)) last = id;
  return last;
}
