import type { Entry, GlossaryTerm } from "@rpgtl/contracts";
import * as Option from "effect/Option";
import { plainText, speakerTagPattern } from "./controlCodes.ts";
import { entryLocation } from "./location.ts";
import { isSpeakerNameEntry } from "./nameEntries.ts";
import { showTextSpeakers } from "./reuse.ts";

const maxLines = 3;
const maxLineLength = 60;

const databaseRoles: Partial<Record<string, string>> = {
  "Classes.json": "class name",
  "Skills.json": "skill name",
  "Items.json": "item name",
  "Weapons.json": "weapon name",
  "Armors.json": "armor name",
  "Enemies.json": "enemy name",
  "States.json": "state name",
};

/** What a game uses an entry's text as, when that says something about the kind of term it is. */
function roleOf(entry: Pick<Entry, "file" | "path">) {
  if (entry.file === "System.json") return "menu or system term";
  if (isSpeakerNameEntry(entry)) return "speaker";
  return Option.match(entryLocation(entry), {
    onNone: () => undefined,
    onSome: (location) => {
      if (location._tag === "MapName") return "map name";
      if (location._tag !== "RecordField") return undefined;
      if (entry.file === "Actors.json") {
        if (location.field === "name") return "actor name";
        if (location.field === "nickname") return "actor nickname";
      }
      return location.field === "name" ? databaseRoles[entry.file] : undefined;
    },
  });
}

export interface TermInput {
  readonly term: string;
  readonly usedAs: ReadonlyArray<string>;
  readonly lines: ReadonlyArray<string>;
}

/** What the kind question sends for each term: where the game uses it and a few lines with it. */
export function termInputs(
  entries: ReadonlyArray<Entry>,
  terms: ReadonlyArray<Pick<GlossaryTerm, "source">>,
): TermInput[] {
  const sources = new Set(terms.map((term) => term.source.trim()));
  const roles = new Map<string, Set<string>>();
  const addRole = (source: string | undefined, role: string) => {
    const key = source?.trim();
    if (!key || !sources.has(key)) return;
    const found = roles.get(key);
    if (found) found.add(role);
    else roles.set(key, new Set([role]));
  };
  const speakerOf = showTextSpeakers(entries);
  const lines: string[] = [];
  for (const entry of entries) {
    const role = roleOf(entry);
    if (role) {
      addRole(entry.source, role);
      continue;
    }
    if (entry.file === "System.json" || entry.file === "plugins.js") continue;
    addRole(speakerOf(entry), "speaker");
    for (const [, name] of entry.source.matchAll(speakerTagPattern)) addRole(name, "speaker");
    lines.push(plainText(entry.source));
  }
  return terms.map((term) => {
    const source = term.source.trim();
    const found = lines.filter((text) => text.includes(source));
    const length = Math.min(maxLines, found.length);
    const picked = Array.from(
      { length },
      (_, i) => found[Math.floor((i * found.length) / length)] ?? "",
    ).map((text) => {
      const at = Math.max(0, text.indexOf(source) - maxLineLength / 2);
      return text.slice(at, at + maxLineLength);
    });
    return { term: source, usedAs: [...(roles.get(source) ?? [])], lines: picked };
  });
}
