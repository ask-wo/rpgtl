import type { Entry, EventList, EventListRef, GameRecord, Location, Table } from "@rpgtl/contracts";
import * as Predicate from "effect/Predicate";
import { sourceText } from "../mvmz/extract.ts";
import { GameFile } from "../mvmz/gameFile.ts";
import { newXpEntry } from "./location.ts";

interface Found {
  readonly location: Location;
  readonly text: string;
  readonly speaker?: string;
}

const hasText = (value: unknown): value is string => Predicate.isString(value) && !!value.trim();

// Event command code -> index of its text parameter.
const textParameter: Partial<Record<number, number>> = {
  320: 1, // Change Actor Name
  402: 1, // When [choice]
};

// Conditional Branch and Show Choices, which start branches, and Else and the choices' When,
// which start the next one.
const branchStarts = new Set([111, 102]);
const nextBranches = new Set([411, 402, 403]);

/**
 * The text of an event list: its messages, choices, names and script texts, in order. A message
 * gets as its speaker the value a script last stored in one of `speakers` before it, in its own
 * branch or before the branches started.
 */
function listText(
  list: EventList,
  ref: EventListRef,
  speakers: ReadonlySet<string>,
): ReadonlyArray<Found> {
  const found: Found[] = [];
  let speaker: string | undefined;
  const atBranchStart = new Map<unknown, string | undefined>();
  for (let index = 0; index < list.length; index++) {
    const command = list[index];
    if (!command) continue;
    const { code, parameters } = command;
    if (branchStarts.has(code)) atBranchStart.set(command["indent"], speaker);
    else if (nextBranches.has(code)) speaker = atBranchStart.get(command["indent"]);
    const stored = code === 355 ? storedString(parameters[0]) : undefined;
    if (stored && speakers.has(stored.variable)) speaker = stored.value.trim() || undefined;
    if (code === 101) {
      // Show Text holds the first line; each 401 after it holds one more.
      let end = index + 1;
      while (list[end]?.code === 401) end++;
      const text = list
        .slice(index, end)
        .map(({ parameters: [line] }) => (Predicate.isString(line) ? line : ""))
        .join("\n");
      if (text.trim())
        found.push({
          location: { _tag: "Message", list: ref, index },
          text,
          ...(speaker !== undefined && { speaker }),
        });
      index = end - 1;
    } else if (code === 102 && Array.isArray(parameters[0])) {
      const choices: ReadonlyArray<unknown> = parameters[0];
      choices.forEach((choice, at) => {
        if (hasText(choice))
          found.push({
            location: { _tag: "CommandText", list: ref, index, parameter: 0, keys: [String(at)] },
            text: choice,
          });
      });
    } else if ((code === 355 || code === 655) && Predicate.isString(parameters[0])) {
      scriptLiterals(parameters[0]).forEach((value, literal) => {
        if (value !== undefined && sourceText.test(value) && value.trim())
          found.push({
            location: { _tag: "ScriptText", list: ref, index, parameter: 0, literal },
            text: value,
          });
      });
    } else {
      const parameter = textParameter[code];
      const text = parameter === undefined ? undefined : parameters[parameter];
      if (parameter !== undefined && hasText(text))
        found.push({
          location: { _tag: "CommandText", list: ref, index, parameter, keys: [] },
          text,
        });
    }
  }
  return found;
}

// A string literal a Ruby script assigns to a variable or compares one with, such as
// `$msg_name = "…"` or `$game_variables[5] == '…'`.
const assignedLiteral =
  /((?:\$?[A-Za-z_]\w*(?:\[\d+\])?)\s*(?:==|!=|=)\s*)("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;

const escapes: Record<string, string> = {
  n: "\n",
  t: "\t",
  s: " ",
  "\\": "\\",
  '"': '"',
  "'": "'",
};

/**
 * The value of a Ruby string literal; none for one whose value isn't plain, such as one with
 * `#{}` in it.
 */
function literalValue(literal: string) {
  const body = literal.slice(1, -1);
  if (literal.startsWith("'")) return body.replace(/\\([\\'])/g, "$1");
  if (/#[{$@]/.test(body)) return undefined;
  let plain = true;
  const value = body.replace(/\\(.)/g, (_, char: string) => {
    const unescaped = escapes[char];
    if (unescaped === undefined) plain = false;
    return unescaped ?? char;
  });
  return plain ? value : undefined;
}

/**
 * The literals an event script stores in or compares with a variable, in order, with the value of
 * each that is plain text.
 */
const scriptLiterals = (script: string) =>
  [...script.matchAll(assignedLiteral)].map((match) => literalValue(match[2] ?? ""));

/**
 * The variable and string of a script that only stores a string, such as `$msg_name = "店主"`;
 * storing `nil` stores "".
 */
function storedString(script: unknown) {
  if (!Predicate.isString(script)) return undefined;
  const [, variable, literal] =
    /^\s*(\$\w+)\s*=\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|nil)\s*$/.exec(script) ?? [];
  const value = literal === "nil" ? "" : literal === undefined ? undefined : literalValue(literal);
  return variable === undefined || value === undefined ? undefined : { variable, value };
}

// Scripts and comments, which may stand between a speaker's name and their message.
const between = new Set([355, 655, 108, 408]);

/**
 * The global variables that hold the speaker's name, which a game's message script draws in a name
 * box: event scripts store a name in them mostly right before a Show Text, and a few names
 * repeat. Clearing one, which some message scripts need after each message, doesn't count. The
 * variable's name differs between message scripts, so it is found from the data.
 */
function speakerVariables(lists: ReadonlyArray<EventList>) {
  const counts = new Map<string, { stores: number; beforeMessage: number; values: Set<string> }>();
  for (const list of lists)
    list.forEach(({ code, parameters }, index) => {
      const stored = code === 355 ? storedString(parameters[0]) : undefined;
      if (!stored?.value.trim()) return;
      const count = counts.get(stored.variable) ?? {
        stores: 0,
        beforeMessage: 0,
        values: new Set(),
      };
      let next = index + 1;
      while (between.has(list[next]?.code ?? 0)) next++;
      count.stores++;
      if (list[next]?.code === 101) count.beforeMessage++;
      count.values.add(stored.value);
      counts.set(stored.variable, count);
    });
  return new Set(
    [...counts].flatMap(([variable, { stores, beforeMessage, values }]) =>
      stores >= 20 && beforeMessage >= stores * 0.8 && values.size >= 2 && values.size * 4 <= stores
        ? [variable]
        : [],
    ),
  );
}

const recordFields = ["name", "description"];

const recordText = (record: GameRecord, table: Table, index: number): ReadonlyArray<Found> =>
  recordFields.flatMap((field) => {
    const text = record[field];
    return hasText(text)
      ? [{ location: { _tag: "RecordField", table, record: index, field } as const, text }]
      : [];
  });

/** The terms of the menus and the names of elements, which System.rxdata keeps. */
function systemText(system: Readonly<Record<string, unknown>>): ReadonlyArray<Found> {
  const found: Found[] = [];
  if (Predicate.isObject(system.words))
    for (const [word, text] of Object.entries(system.words))
      if (hasText(text))
        found.push({ location: { _tag: "SystemText", keys: ["words", word] }, text });
  if (Array.isArray(system.elements))
    system.elements.forEach((text: unknown, at) => {
      if (hasText(text))
        found.push({ location: { _tag: "SystemText", keys: ["elements", String(at)] }, text });
    });
  return found;
}

interface PlacedList {
  readonly list: EventList;
  readonly ref: EventListRef;
}

const eventLists = (file: GameFile): ReadonlyArray<PlacedList> =>
  GameFile.$match(file, {
    Map: ({ map, data }) =>
      data.events.flatMap((event, id) =>
        event
          ? event.pages.map((page, at) => ({
              list: page.list,
              ref: { _tag: "MapEventPage", map, event: id, page: at } as const,
            }))
          : [],
      ),
    CommonEvents: ({ data }) =>
      data.flatMap((event, id) =>
        event ? [{ list: event.list, ref: { _tag: "CommonEvent", event: id } as const }] : [],
      ),
    Troops: ({ data }) =>
      data.flatMap((troop, id) =>
        troop
          ? troop.pages.map((page, at) => ({
              list: page.list,
              ref: { _tag: "TroopPage", troop: id, page: at } as const,
            }))
          : [],
      ),
    System: () => [],
    Database: () => [],
    Tilesets: () => [],
    Other: () => [],
  });

const fileText = (file: GameFile, speakers: ReadonlySet<string>): ReadonlyArray<Found> => [
  ...eventLists(file).flatMap(({ list, ref }) => listText(list, ref, speakers)),
  ...GameFile.$match(file, {
    System: ({ data }) => systemText(data),
    Database: ({ table, data }) =>
      data.flatMap((record, index) => (record ? recordText(record, table, index) : [])),
    Map: () => [],
    CommonEvents: () => [],
    Troops: () => [],
    Tilesets: () => [],
    Other: () => [],
  }),
];

/** An XP game's catalog entries: the text of its data files, in the order given. */
export function xpGameEntries(dataFiles: ReadonlyArray<GameFile>): Entry[] {
  const speakers = speakerVariables(dataFiles.flatMap(eventLists).map(({ list }) => list));
  return dataFiles
    .flatMap((file) => fileText(file, speakers))
    .map(({ location, text, speaker }) => ({
      ...newXpEntry(location, text),
      ...(speaker !== undefined && { speaker }),
    }));
}
