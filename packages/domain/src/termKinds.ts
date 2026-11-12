import type { Entry, GlossaryTerm, Table } from "@rpgtl/contracts";
import { plainText, speakerTagPattern } from "./controlCodes.ts";
import { isSettingText, isSystemText } from "./location.ts";
import { isSpeakerNameEntry } from "./nameEntries.ts";
import { showTextSpeakers } from "./reuse.ts";

const maxLines = 3;
const maxLineLength = 60;

const databaseRoles: Partial<Record<Table, string>> = {
  classes: "class name",
  skills: "skill name",
  items: "item name",
  weapons: "weapon name",
  armors: "armor name",
  enemies: "enemy name",
  states: "state name",
};

/** What a game uses an entry's text as, when that says something about the kind of term it is. */
function roleOf(entry: Entry) {
  const { location } = entry;
  if (isSystemText(entry)) return "menu or system term";
  if (isSpeakerNameEntry(entry)) return "speaker";
  if (location._tag === "MapName") return "map name";
  if (location._tag !== "RecordField") return undefined;
  if (location.table === "actors") {
    if (location.field === "name") return "actor name";
    if (location.field === "nickname") return "actor nickname";
  }
  return location.field === "name" ? databaseRoles[location.table] : undefined;
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
    if (isSettingText(entry)) continue;
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
