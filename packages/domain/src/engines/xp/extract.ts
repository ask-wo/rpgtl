import type { Entry, EventList, EventListRef, GameRecord, Location, Table } from "@rpgtl/contracts";
import * as Predicate from "effect/Predicate";
import { sourceText } from "../mvmz/extract.ts";
import { GameFile } from "../mvmz/gameFile.ts";
import { newXpEntry } from "./location.ts";

interface Found {
  readonly location: Location;
  readonly text: string;
}

const hasText = (value: unknown): value is string => Predicate.isString(value) && !!value.trim();

// Event command code -> index of its text parameter.
const textParameter: Partial<Record<number, number>> = {
  320: 1, // Change Actor Name
  402: 1, // When [choice]
};

/** The text of an event list: its messages, choices, names and script texts, in order. */
function listText(list: EventList, ref: EventListRef): ReadonlyArray<Found> {
  const found: Found[] = [];
  for (let index = 0; index < list.length; index++) {
    const command = list[index];
    if (!command) continue;
    const { code, parameters } = command;
    if (code === 101) {
      // Show Text holds the first line; each 401 after it holds one more.
      let end = index + 1;
      while (list[end]?.code === 401) end++;
      const text = list
        .slice(index, end)
        .map(({ parameters: [line] }) => (Predicate.isString(line) ? line : ""))
        .join("\n");
      if (text.trim()) found.push({ location: { _tag: "Message", list: ref, index }, text });
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

function fileText(file: GameFile): ReadonlyArray<Found> {
  return GameFile.$match(file, {
    Map: ({ map, data }) =>
      data.events.flatMap((event, id) =>
        event
          ? event.pages.flatMap((page, at) =>
              listText(page.list, { _tag: "MapEventPage", map, event: id, page: at }),
            )
          : [],
      ),
    CommonEvents: ({ data }) =>
      data.flatMap((event, id) =>
        event ? listText(event.list, { _tag: "CommonEvent", event: id }) : [],
      ),
    Troops: ({ data }) =>
      data.flatMap((troop, id) =>
        troop
          ? troop.pages.flatMap((page, at) =>
              listText(page.list, { _tag: "TroopPage", troop: id, page: at }),
            )
          : [],
      ),
    System: ({ data }) => systemText(data),
    Database: ({ table, data }) =>
      data.flatMap((record, index) => (record ? recordText(record, table, index) : [])),
    Tilesets: () => [],
    Other: () => [],
  });
}

/** An XP game's catalog entries: the text of its data files, in the order given. */
export const xpGameEntries = (dataFiles: ReadonlyArray<GameFile>): Entry[] =>
  dataFiles.flatMap(fileText).map(({ location, text }) => newXpEntry(location, text));
