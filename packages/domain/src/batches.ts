import { imagePath } from "@rpgtl/contracts";
import type { CatalogDraft, Prepared, RunEntry } from "./catalogDraft.ts";
import { seriesName } from "./imageText.ts";
import { isNameEntry, isSpeakerNameEntry } from "./nameEntries.ts";
import type { ContextLine, RequestEntry } from "./prompts.ts";
import { withoutCodes } from "./requestText.ts";
import { translationInUse } from "./inUse.ts";
import { isImageText, listKey, type Placed, placeKey, placeOf } from "./location.ts";
import { hasTerm } from "./termMatch.ts";

/**
 * The event list an entry belongs to, or its file outside event lists: one scene of the game. The
 * images of a series, such as a menu's buttons drawn as `Command_0` to `Command_3`, are one scene,
 * so the translator sees the menu's other labels.
 */
export const sceneKey = ({ location }: Placed) => {
  if (location === undefined) return "";
  if (location._tag === "ImageLines")
    return `image ${seriesName(location.image) ?? location.image}`;
  if ("list" in location) return listKey(location.list);
  return placeKey(placeOf(location));
};

const grouped = (entries: ReadonlyArray<RunEntry>, key: (entry: RunEntry) => string) => {
  const groups = new Map<string, Array<RunEntry>>();
  for (const entry of entries) {
    const group = groups.get(key(entry));
    if (group) group.push(entry);
    else groups.set(key(entry), [entry]);
  }
  return [...groups.values()];
};

const left = (group: ReadonlyArray<RunEntry>) =>
  group.filter((entry) => !translationInUse(entry)).length;

/** The group cut into groups of at most `batchSize` untranslated entries. */
const cut = (group: ReadonlyArray<RunEntry>, batchSize: number) => {
  const groups: Array<Array<RunEntry>> = [[]];
  for (const entry of group) {
    const current = groups.at(-1) ?? [];
    if (!translationInUse(entry) && left(current) === batchSize) groups.push([entry]);
    else current.push(entry);
  }
  return groups;
};

/**
 * Name entries by place, which the glossary pass translates into the glossary first, cut into
 * groups of at most `batchSize` untranslated names. A group's batches go one after another, and
 * names need no earlier answers, so a long table such as a game's thousands of skills still runs
 * its batches side by side.
 */
export const nameGroups = (entries: ReadonlyArray<RunEntry>, batchSize: number) =>
  grouped(entries.filter(isNameEntry), ({ location }) =>
    location ? placeKey(placeOf(location)) : "",
  ).flatMap((group) => cut(group, batchSize));

/**
 * The untranslated names that two or more other untranslated names contain, such as a character's
 * name in the items named after her. The glossary pass translates them first, so that the batches
 * of those other names, which run side by side, get their English as a hint. A source listed twice,
 * such as a character's name and the same character as a speaker, goes once.
 */
export function sharedNames(entries: ReadonlyArray<RunEntry>) {
  const sources = [
    ...new Set(entries.filter((entry) => !translationInUse(entry)).map((e) => e.source.trim())),
  ];
  const shorter = sources.filter((source) => Array.from(source).length >= 2);
  const lengths = [...new Set(shorter.map((source) => source.length))];
  const known = new Set(shorter);
  const containing = new Map<string, number>();
  for (const name of sources) {
    const inside = new Set<string>();
    for (const length of lengths)
      for (let at = 0; at + length <= name.length; at++) {
        const part = name.slice(at, at + length);
        if (part !== name && known.has(part) && hasTerm(name, part)) inside.add(part);
      }
    for (const part of inside) containing.set(part, (containing.get(part) ?? 0) + 1);
  }
  const picked = new Set<string>();
  return entries.filter((entry) => {
    const source = entry.source.trim();
    if (translationInUse(entry) || (containing.get(source) ?? 0) < 2 || picked.has(source))
      return false;
    picked.add(source);
    return true;
  });
}

/**
 * The other entries by scene, which see the scene's earlier lines as context. Only an event list
 * needs them in order; a scene outside one, such as a table's thousands of descriptions, is cut
 * like `nameGroups` so its batches run side by side.
 */
export const textGroups = (entries: ReadonlyArray<RunEntry>, batchSize: number) =>
  grouped(
    entries.filter((entry) => !isNameEntry(entry)),
    sceneKey,
  ).flatMap((group) =>
    group[0]?.location !== undefined && "list" in group[0].location
      ? [group]
      : cut(group, batchSize),
  );

/**
 * Speakers the glossary has no English for, from Show Text speakers, speaker tags and MZ speaker
 * names, as entries of their own that live only for the run. A name that is only control codes,
 * which the game fills in, can't be a term, so it isn't one.
 */
export function speakerEntries(draft: CatalogDraft, prepared: ReadonlyArray<Prepared>) {
  const names = new Set<string>();
  for (const item of prepared)
    for (const name of [
      draft.speakerName(item),
      isSpeakerNameEntry(item.entry) ? item.entry.source : undefined,
    ]) {
      const trimmed = name?.trim();
      if (trimmed && withoutCodes(trimmed).trim() && !draft.translatedTerm(trimmed))
        names.add(trimmed);
    }
  return [...names].map((name): RunEntry => ({
    id: `speaker:${name}`,
    source: name,
    isInImage: false,
  }));
}

/** Packs groups with fewer entries left than a batch together, up to a batch each; a longer group goes alone. */
export function packGroups(groups: ReadonlyArray<ReadonlyArray<RunEntry>>, batchSize: number) {
  const packed: Array<ReadonlyArray<RunEntry>> = [];
  let current: Array<RunEntry> = [];
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
        ...(translationInUse(item.entry) && {
          translation: withoutCodes(translationInUse(item.entry)),
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
      ...(isImageText(item.entry) && { image: item.entry.location.image.replace(imagePath, "") }),
      ...(limit !== undefined && { limit }),
    };
  });
  return { context, entries };
}
