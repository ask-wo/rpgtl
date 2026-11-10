import type { Entry } from "@rpgtl/contracts";
import type { CatalogDraft, DraftEntry, Prepared } from "./catalogDraft.ts";
import { seriesName } from "./imageText.ts";
import { isNameEntry, isSpeakerNameEntry } from "./nameEntries.ts";
import type { ContextLine, RequestEntry } from "./prompts.ts";
import { withoutCodes } from "./requestText.ts";
import { entryTranslation } from "./guesses.ts";

/**
 * The event list an entry belongs to, or its file outside event lists: one scene of the game. The
 * images of a series, such as a menu's buttons drawn as `Command_0` to `Command_3`, are one scene,
 * so the translator sees the menu's other labels.
 */
export const sceneKey = (entry: Pick<Entry, "file" | "path">) => {
  if (entry.file.startsWith("img/")) return JSON.stringify([seriesName(entry.file) ?? entry.file]);
  const list = entry.path.indexOf("list");
  return JSON.stringify([entry.file, list < 0 ? [] : entry.path.slice(0, list + 1)]);
};

const grouped = (entries: ReadonlyArray<DraftEntry>, key: (entry: DraftEntry) => string) => {
  const groups = new Map<string, Array<DraftEntry>>();
  for (const entry of entries) {
    const group = groups.get(key(entry));
    if (group) group.push(entry);
    else groups.set(key(entry), [entry]);
  }
  return [...groups.values()];
};

/** Name entries by file, which the glossary pass translates into the glossary first. */
export const nameGroups = (entries: ReadonlyArray<DraftEntry>) =>
  grouped(entries.filter(isNameEntry), (entry) => entry.file);

/** The other entries by scene, which see the scene's earlier lines as context. */
export const textGroups = (entries: ReadonlyArray<DraftEntry>) =>
  grouped(
    entries.filter((entry) => !isNameEntry(entry)),
    sceneKey,
  );

/**
 * Speakers the glossary has no English for, from Show Text speakers, speaker tags and MZ speaker
 * names, as entries of their own that live only for the run.
 */
export function speakerEntries(draft: CatalogDraft, prepared: ReadonlyArray<Prepared>) {
  const names = new Set<string>();
  for (const item of prepared)
    for (const name of [
      draft.speakerName(item),
      isSpeakerNameEntry(item.entry) ? item.entry.source : undefined,
    ]) {
      const trimmed = name?.trim();
      if (trimmed && !draft.term(trimmed)) names.add(trimmed);
    }
  return [...names].map((name): DraftEntry => ({
    id: `speaker:${name}`,
    file: "",
    path: [],
    source: name,
    translation: {},
  }));
}

const left = (group: ReadonlyArray<DraftEntry>) =>
  group.filter((entry) => !entryTranslation(entry)).length;

/** Packs groups with fewer entries left than a batch together, up to a batch each; a longer group goes alone. */
export function packGroups(groups: ReadonlyArray<ReadonlyArray<DraftEntry>>, batchSize: number) {
  const packed: Array<ReadonlyArray<DraftEntry>> = [];
  let current: Array<DraftEntry> = [];
  for (const group of groups) {
    if (left(group) >= batchSize) {
      packed.push(group);
      continue;
    }
    if (left(current) + left(group) > batchSize) {
      packed.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length) packed.push(current);
  return packed;
}

/**
 * Splits a scene's entries into requests: the whole scene in one when it has at most `sceneSize`,
 * or else `batchSize` at a time.
 */
export function sceneBatches<A>(items: ReadonlyArray<A>, batchSize: number, sceneSize: number) {
  const size = items.length <= sceneSize ? Math.max(items.length, 1) : batchSize;
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );
}

/** What a request sends about a batch besides the instructions and the glossary. */
export interface BatchRequest {
  readonly context: ReadonlyArray<ContextLine>;
  readonly entries: ReadonlyArray<RequestEntry>;
}

/**
 * A batch's entries, numbered from 1, with up to `contextLines` lines before it in each of its
 * scenes as context. A packed batch holds short event lists of several scenes; each keeps its own
 * context, and its entries carry their scene's number.
 */
export function batchRequest(
  draft: CatalogDraft,
  group: ReadonlyArray<Prepared>,
  batch: ReadonlyArray<Prepared>,
  contextLines: number,
): BatchRequest {
  const scenes = [...new Set(batch.map((item) => sceneKey(item.entry)))];
  const sceneOf = (item: Prepared) =>
    scenes.length > 1 ? { scene: scenes.indexOf(sceneKey(item.entry)) + 1 } : {};
  const speakerOf = (item: Prepared) => {
    const speaker = draft.speaker(item);
    return speaker === undefined ? {} : { speaker };
  };
  const context = scenes.flatMap((scene) => {
    const first = group.findIndex((item) => batch.includes(item) && sceneKey(item.entry) === scene);
    return group
      .slice(0, first)
      .filter((item) => sceneKey(item.entry) === scene && !isSpeakerNameEntry(item.entry))
      .slice(-contextLines)
      .map((item): ContextLine => ({
        ...sceneOf(item),
        ...speakerOf(item),
        source: withoutCodes(item.entry.source),
        ...(entryTranslation(item.entry) && {
          translation: withoutCodes(entryTranslation(item.entry)),
        }),
      }));
  });
  const entries = batch.map((item, index): RequestEntry => {
    const limit = draft.tightLimit(item);
    return {
      id: String(index + 1),
      ...sceneOf(item),
      ...speakerOf(item),
      text: item.text,
      ...(item.entry.file.startsWith("img/") && { image: item.entry.file.slice("img/".length) }),
      ...(limit !== undefined && { limit }),
    };
  });
  return { context, entries };
}
