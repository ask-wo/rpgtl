import type { Catalog, SampleGroup, Samples } from "@rpgtl/contracts";
import { type EntryText, entryTexts } from "./catalog.ts";
import * as Option from "effect/Option";
import { CatalogDraft } from "./catalogDraft.ts";
import { speakerTagPattern } from "./controlCodes.ts";
import { EventListRef } from "@rpgtl/contracts";

const dialogueScenes = 6;
const sceneLines = 10;

/** The event list an entry's command is in, when it is in one. */
const eventListOf = ({ location }: EntryText) =>
  location._tag === "Message" || location._tag === "CommandText" || location._tag === "ScriptText"
    ? Option.some(location.list)
    : Option.none();

const describeList = EventListRef.match({
  CommonEvent: ({ event }) => `common event ${event}`,
  TroopPage: ({ troop, page }) => `troop ${troop} page ${page + 1}`,
  MapEventPage: ({ map, event, page }) => `map ${map} event ${event} page ${page + 1}`,
});

const hasSpeakerTag = (entry: EntryText) => entry.source.search(speakerTagPattern) >= 0;
const hasControlCode = (entry: EntryText) =>
  /\\(?:N|V|C|I)\[/i.test(entry.source) || /\\!(?!\s*$)/.test(entry.source);

/**
 * Entries to compare translators on: scenes with the most speakers, menu terms, item and skill
 * descriptions, and lines with control codes. A scene whose text is already in the sample, as
 * where an event repeats another, is skipped.
 */
export function pickSamples(catalog: Pick<Catalog, "game" | "entries" | "texts">): Samples {
  const all = entryTexts(catalog);
  const lists = new Map<string, { label: string; entries: Array<EntryText> }>();
  for (const entry of all) {
    const list = eventListOf(entry);
    if (Option.isNone(list)) continue;
    const key = JSON.stringify(list.value);
    const found = lists.get(key);
    if (found) found.entries.push(entry);
    else lists.set(key, { label: describeList(list.value), entries: [entry] });
  }

  const groups: Array<SampleGroup> = [];
  const used = new Set<string>();
  const sources = new Set<string>();
  const add = (label: string, entries: ReadonlyArray<EntryText>) => {
    const fresh = entries.filter((entry) => !used.has(entry.id));
    for (const entry of fresh) {
      used.add(entry.id);
      sources.add(entry.source);
    }
    if (fresh.length) groups.push({ label, ids: fresh.map((entry) => entry.id) });
  };

  const dialogue = [...lists.values()]
    .map((list) => ({ ...list, tags: list.entries.filter(hasSpeakerTag).length }))
    .toSorted((a, b) => b.tags - a.tags || b.entries.length - a.entries.length);
  let scenes = 0;
  for (const { label, entries } of dialogue) {
    if (scenes === dialogueScenes) break;
    const start = Math.max(0, entries.findIndex(hasSpeakerTag));
    const window = entries.slice(start, start + sceneLines);
    if (window.some((entry) => sources.has(entry.source))) continue;
    add(`Dialogue: ${label}`, window);
    scenes++;
  }

  add(
    "Menu terms",
    all
      .filter(({ location }) => location._tag === "SystemText" && location.keys[0] === "terms")
      .slice(0, 20),
  );
  add(
    "Descriptions",
    (["items", "skills", "weapons", "armors"] as const).flatMap((table) =>
      all
        .filter(
          ({ location }) =>
            location._tag === "RecordField" &&
            location.table === table &&
            location.field === "description",
        )
        .slice(0, 3),
    ),
  );
  add(
    "Control codes",
    all.filter((entry) => !used.has(entry.id) && hasControlCode(entry)).slice(0, 15),
  );
  return { gameId: catalog.game.id, groups };
}

/**
 * The catalog a comparison translates: the sample's entries, untranslated but for fixed ones,
 * and the glossary with pronouns from the whole game, since a sample holds too few clues.
 */
export function sampleCatalog(catalog: Catalog, samples: Samples): Catalog {
  const whole = new CatalogDraft(catalog, new Map());
  whole.pronounsFromClues();
  const ids = new Set(samples.groups.flatMap((group) => group.ids));
  const entries = catalog.entries.filter((entry) => ids.has(entry.id));
  const fixed = new Map<number, string>();
  for (const entry of entries) {
    const translation = samples.fixed?.[entry.id];
    if (translation !== undefined) fixed.set(entry.textId, translation);
  }
  const used = new Set(entries.map((entry) => entry.textId));
  return {
    ...catalog,
    settings: { ...catalog.settings, sourceLanguage: whole.language },
    glossary: whole.glossary.filter((term) => term.id >= 0),
    entries,
    texts: catalog.texts.flatMap(({ id, source, speaker, isInImage }) => {
      if (!used.has(id)) return [];
      const userTranslation = fixed.get(id);
      return [
        {
          id,
          source,
          isInImage,
          ...(speaker !== undefined && { speaker }),
          ...(userTranslation !== undefined && { userTranslation }),
        },
      ];
    }),
  };
}
