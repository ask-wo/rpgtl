import type {
  Entry,
  EventCommand,
  EventList,
  EventListRef,
  GameRecord,
  Location,
  NoteOwner,
  Plugins,
  Table,
} from "@rpgtl/contracts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { GameFile } from "./gameFile.ts";
import { assetNames } from "../../inspect.ts";
import type { Placed } from "../../location.ts";
import { newEntry } from "./location.ts";

// Chinese, Japanese or Korean text. Other values are settings, numbers or English labels.
export const sourceText = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9d\uac00-\ud7af]/;

/** The parameters of enabled plugins by plugin name. */
export const pluginParameters = (plugins: Plugins) =>
  new Map(plugins.flatMap((plugin) => (plugin?.status ? [[plugin.name, plugin.parameters]] : [])));

export const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

/** The Show Text or Scrolling Text lines that start at `first`, as one text, and where they end. */
export function messageRun(list: EventList, first: number) {
  const code = list[first]?.code;
  if (code !== 401 && code !== 405) return undefined;
  let end = first + 1;
  while (list[end]?.code === code) end++;
  return {
    source: list
      .slice(first, end)
      .map(({ parameters: [line] }) => (Predicate.isString(line) ? line : ""))
      .join("\n"),
    end,
  };
}

// A string literal an event script stores in a variable or compares a variable with, such as
// `$gameVariables.setValue(5, "人类")` or `$gameVariables.value(5) == "人类"`.
const variableLiteral =
  /(\$gameVariables\.setValue\([^,()]+,\s*|\$gameVariables\.value\([^()]+\)\s*[!=]==?\s*)("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;

const stringValue = (literal: string) =>
  decodeJsonString(
    literal.startsWith('"')
      ? literal
      : `"${literal.slice(1, -1).replace(/\\'|"/g, (m) => (m === '"' ? '\\"' : "'"))}"`,
  );

/** The variable text literals in an event script, in order. Translating them keeps comparisons working. */
export function variableStrings(script: string) {
  return [...script.matchAll(variableLiteral)].flatMap((match) => {
    const [whole, before = "", literal = ""] = match;
    return Option.match(stringValue(literal), {
      onNone: () => [],
      onSome: (value) => [
        { start: match.index + before.length, end: match.index + whole.length, value },
      ],
    });
  });
}

/**
 * The values of a note's tags such as `<AddInfoWindowP:\\C[4]品级  \\C[0]普通>`, in order. A value
 * may span lines, as in the engine's `DataManager.extractMetadata`.
 */
export function noteTags(note: string) {
  return [...note.matchAll(/<[^<>:\s][^<>:\n]*:([^<>]*)>/g)].map((match) => {
    const value = match[1] ?? "";
    const start = match.index + match[0].indexOf(":") + 1;
    return { start, end: start + value.length, value };
  });
}

/**
 * Whether a note tag's value is drawn as text: it holds a text code such as `\\C[4]`, a line break
 * or sentence punctuation. Other values are often file names or keys that plugins look up.
 */
export const isDrawnTag = (value: string) => /\\[A-Za-z]+\[\d+\]|\n|[。！？…]/.test(value.trim());

const recordFields = new Set([
  "name",
  "nickname",
  "profile",
  "description",
  "message1",
  "message2",
  "message3",
  "message4",
]);
// System.json lists and groups of terms, whose every text is shown.
const systemLists = new Set([
  "terms",
  "elements",
  "skillTypes",
  "weaponTypes",
  "armorTypes",
  "equipTypes",
]);

// Event command code -> index of its player-visible text parameter.
const textParameter: Partial<Record<number, number>> = {
  101: 4, // Show Text: speaker name (MZ)
  102: 0, // Show Choices
  320: 1, // Change Name
  324: 1, // Change Nickname
  325: 1, // Change Profile
  402: 1, // When [choice]
};

// Commands after which a dialogue picture no longer names the speaker: conditions, choices, labels.
const sceneBreaks = new Set([111, 411, 412, 102, 402, 403, 404, 118, 119]);

// Event command code -> index of its script parameter.
const scriptParameter = ({ code, parameters }: EventCommand) =>
  code === 355 || code === 655 ? 0 : code === 111 && parameters[0] === 12 ? 1 : undefined;

/** Plugin headers and the game's files, which tell which plugin values are text. */
export interface PluginText {
  /** The arguments a plugin's header marks as something other than text. */
  readonly nonText: (plugin: string) => ReadonlySet<string>;
  /** The game's pictures, sounds and movies, which plugin values may name. */
  readonly fileNames: ReadonlySet<string>;
}

const noPluginText: PluginText = { nonText: () => new Set(), fileNames: new Set() };

/** Text found in a game file, with where it is. */
interface Found {
  readonly location: Location;
  readonly text: string;
  readonly speaker?: string;
}

/**
 * The Chinese text in a plugin value at `keys`, looking inside lists and structs stored as JSON
 * text. Values in `fileNames` name a picture, sound or movie of the game and are skipped.
 */
function pluginText(
  value: unknown,
  keys: ReadonlyArray<string>,
  skipped: ReadonlySet<string>,
  fileNames: ReadonlySet<string>,
): ReadonlyArray<{ keys: ReadonlyArray<string>; text: string }> {
  if (Predicate.isString(value)) {
    const parsed = /^\s*[[{]/.test(value) ? decodeJson(value) : Option.none();
    if (Option.isSome(parsed)) return pluginText(parsed.value, keys, skipped, fileNames);
    return sourceText.test(value) && !fileNames.has(value) && value.trim()
      ? [{ keys, text: value }]
      : [];
  }
  if (Array.isArray(value))
    return value.flatMap((item: unknown, index) =>
      pluginText(item, [...keys, String(index)], skipped, fileNames),
    );
  if (Predicate.isObject(value))
    return Object.entries(value).flatMap(([key, item]) =>
      skipped.has(key) ? [] : pluginText(item, [...keys, key], skipped, fileNames),
    );
  return [];
}

/** Every non-blank string in a value, with the keys to it. */
function strings(
  value: unknown,
  keys: ReadonlyArray<string> = [],
): ReadonlyArray<{ keys: ReadonlyArray<string>; text: string }> {
  if (Predicate.isString(value)) return value.trim() ? [{ keys, text: value }] : [];
  if (Array.isArray(value))
    return value.flatMap((item: unknown, index) => strings(item, [...keys, String(index)]));
  if (Predicate.isObject(value))
    return Object.entries(value).flatMap(([key, item]) => strings(item, [...keys, key]));
  return [];
}

const noteText = (note: unknown, owner: NoteOwner): ReadonlyArray<Found> =>
  Predicate.isString(note)
    ? noteTags(note).flatMap(({ value }, tag) =>
        isDrawnTag(value) && sourceText.test(value) && value.trim()
          ? [{ location: { _tag: "NoteTag", owner, tag } as const, text: value }]
          : [],
      )
    : [];

const nameText = (location: Location, name: unknown): ReadonlyArray<Found> =>
  Predicate.isString(name) && sourceText.test(name) && name.trim()
    ? [{ location, text: name }]
    : [];

const dialoguePicture = /^[(（]对话框(?:特殊)?[)）](.+?)(?:\d+)?$/;

function commandText(
  { code, parameters }: EventCommand,
  list: EventListRef,
  index: number,
  { nonText, fileNames }: PluginText,
): ReadonlyArray<Found> {
  const found: Found[] = [];
  const parameter = textParameter[code];
  if (parameter !== undefined)
    for (const { keys, text } of strings(parameters[parameter]))
      found.push({ location: { _tag: "CommandText", list, index, parameter, keys }, text });
  // MZ Plugin Command: [plugin, command, command label, arguments].
  if (code === 357)
    for (const { keys, text } of pluginText(
      parameters[3],
      [],
      nonText(String(parameters[0])),
      fileNames,
    ))
      found.push({ location: { _tag: "CommandText", list, index, parameter: 3, keys }, text });
  const script = scriptParameter({ code, parameters });
  const source = script === undefined ? undefined : parameters[script];
  if (script !== undefined && Predicate.isString(source))
    variableStrings(source).forEach(({ value }, literal) => {
      if (sourceText.test(value) && value.trim())
        found.push({
          location: { _tag: "ScriptText", list, index, parameter: script, literal },
          text: value,
        });
    });
  return found;
}

/** The text of an event list: its messages, command texts and script texts, in order. */
function listText(list: EventList, ref: EventListRef, plugins: PluginText): ReadonlyArray<Found> {
  const found: Found[] = [];
  const dialoguePictures = new Map<unknown, string>();
  for (let index = 0; index < list.length; index++) {
    const command = list[index];
    if (!command) continue;
    const [id, picture] = command.parameters;
    if (sceneBreaks.has(command.code)) dialoguePictures.clear();
    if (command.code === 231) {
      dialoguePictures.delete(id);
      const name = Predicate.isString(picture)
        ? dialoguePicture.exec(picture)?.[1]?.trim()
        : undefined;
      if (name) dialoguePictures.set(id, name);
    } else if (command.code === 235) dialoguePictures.delete(id);
    const run = messageRun(list, index);
    if (run) {
      const [speaker] = dialoguePictures.values();
      if (run.source.trim())
        found.push({
          location: { _tag: "Message", list: ref, index },
          text: run.source,
          ...(speaker && dialoguePictures.size === 1 && { speaker }),
        });
      index = run.end - 1;
    } else found.push(...commandText(command, ref, index, plugins));
  }
  return found;
}

const recordText = (
  record: GameRecord,
  table: Table,
  index: number,
  fields: boolean,
): ReadonlyArray<Found> =>
  Object.entries(record).flatMap(([field, value]): ReadonlyArray<Found> => {
    if (field === "note") return noteText(value, { _tag: "Record", table, record: index });
    if (field === "learnings" && Array.isArray(value))
      return value.flatMap((learning: unknown, at) =>
        Predicate.isObject(learning)
          ? noteText(learning.note, { _tag: "ClassLearning", record: index, learning: at })
          : [],
      );
    return fields && recordFields.has(field) && Predicate.isString(value) && value.trim()
      ? [{ location: { _tag: "RecordField", table, record: index, field }, text: value }]
      : [];
  });

const namesIn = (group: "switches" | "variables", names: unknown) =>
  Array.isArray(names)
    ? names.flatMap((name: unknown, id) => nameText({ _tag: "Name", group, id }, name))
    : [];

/** The text of a game file, in the order of the file. */
function fileText(file: GameFile, plugins: PluginText): ReadonlyArray<Found> {
  return GameFile.$match(file, {
    // In RPG Maker's order of a map's fields, which decoding doesn't keep.
    Map: ({ map, data }) => [
      ...data.events.flatMap((event, id) =>
        event ? nameText({ _tag: "EventName", map, event: id }, event.name) : [],
      ),
      ...(Predicate.isString(data.displayName) && data.displayName.trim()
        ? [{ location: { _tag: "MapName", map } as const, text: data.displayName }]
        : []),
      ...noteText(data.note, { _tag: "Map", map }),
      ...data.events.flatMap((event, id) =>
        event
          ? [
              ...noteText(event.note, { _tag: "MapEvent", map, event: id }),
              ...event.pages.flatMap((page, at) =>
                listText(page.list, { _tag: "MapEventPage", map, event: id, page: at }, plugins),
              ),
            ]
          : [],
      ),
    ],
    CommonEvents: ({ data }) =>
      data.flatMap((event, id) =>
        event ? listText(event.list, { _tag: "CommonEvent", event: id }, plugins) : [],
      ),
    Troops: ({ data }) =>
      data.flatMap((troop, id) =>
        troop
          ? troop.pages.flatMap((page, at) =>
              listText(page.list, { _tag: "TroopPage", troop: id, page: at }, plugins),
            )
          : [],
      ),
    System: ({ data }) => {
      const names = [
        ...namesIn("switches", data.switches),
        ...namesIn("variables", data.variables),
      ];
      const rest = Object.entries(data).flatMap(([key, value]): ReadonlyArray<Found> => {
        if (systemLists.has(key))
          return strings(value, [key]).map(({ keys, text }) => ({
            location: { _tag: "SystemText", keys } as const,
            text,
          }));
        return (key === "gameTitle" || key === "currencyUnit") &&
          Predicate.isString(value) &&
          value.trim()
          ? [{ location: { _tag: "SystemText", keys: [key] } as const, text: value }]
          : [];
      });
      return [...names, ...rest];
    },
    Database: ({ table, data }) =>
      data.flatMap((record, index) => (record ? recordText(record, table, index, true) : [])),
    Tilesets: ({ data }) =>
      data.flatMap((record, index) => (record ? recordText(record, "tilesets", index, false) : [])),
    Scripts: () => [],
    Other: () => [],
  });
}

/**
 * Extracts the player-visible text of a data file such as `Map001.json`. `plugins` tells which
 * MZ plugin command arguments are text.
 */
export const extract = (data: GameFile, plugins: PluginText = noPluginText): Entry[] =>
  fileText(data, plugins).map(({ location, text, speaker }) => ({
    ...newEntry(location, text),
    ...(speaker !== undefined && { speaker }),
  }));

/** Text in the settings of enabled plugins, including lists and structs. */
export const extractPlugins = (plugins: Plugins, { nonText, fileNames }: PluginText): Entry[] =>
  [...pluginParameters(plugins)].flatMap(([plugin, parameters]) =>
    pluginText(parameters, [], nonText(plugin), fileNames).map(({ keys, text }) =>
      newEntry({ _tag: "PluginSetting", plugin, keys }, text),
    ),
  );

/** The files below a game's web root that its catalog entries come from, as read. */
export interface GameText {
  readonly plugins: Plugins;
  /** The code of each listed plugin whose file is there, by name. */
  readonly pluginCode: ReadonlyMap<string, string>;
  /** The paths below the web root of the files under img/, audio/ and movies/. */
  readonly assets: ReadonlyArray<string>;
  readonly dataFiles: ReadonlyArray<{ readonly name: string; readonly data: GameFile }>;
}

/** A game's catalog entries: its data files' text in the order given, then its plugins'. */
export function gameEntries({ plugins, pluginCode, assets, dataFiles }: GameText): Entry[] {
  const nonText = new Map(
    plugins.flatMap((plugin) =>
      plugin ? [[plugin.name, nonTextParameters(pluginCode.get(plugin.name) ?? "")] as const] : [],
    ),
  );
  const settings = {
    nonText: (name: string) => nonText.get(name) ?? new Set<string>(),
    fileNames: assetNames(assets),
  };
  return [
    ...dataFiles.flatMap(({ data }) => extract(data, settings)),
    ...extractPlugins(plugins, settings),
  ];
}

// Parameter types whose value is shown to the player as it is. Untyped parameters are strings.
const textTypes = new Set(["string", "multiline_string", "note"]);

/**
 * Names of the parameters, struct fields and command arguments a plugin's header marks as something
 * other than text, such as files. Lists and structs hold text, so they are not marked.
 */
export function nonTextParameters(code: string) {
  const names = new Set<string>();
  for (const block of code.match(/\/\*(?::|~struct~)[^]*?\*\//g) ?? [])
    for (const param of block.split(/^\s*\*?\s*@(?:param|arg)\s+/m).slice(1)) {
      const name = (param.split("\n")[0] ?? "").trim();
      const body = param.split(/^\s*\*?\s*@(?:command|help|struct)\b/m)[0] ?? "";
      const type = /@type\s+(\S+)/.exec(body)?.[1]?.replace(/(?:\[\])+$/, "");
      if ((type && !textTypes.has(type) && !type.startsWith("struct<")) || /@dir\b/.test(body))
        names.add(name);
    }
  return names;
}

/**
 * A credits plugin's line such as "画师:青木流水" or "制作人 星澜Uno": the role is translated and the
 * names after it are kept as written, joined with ": ".
 */
export function creditLine(entry: Pick<Entry, "source"> & Placed) {
  if (entry.location?._tag !== "PluginSetting" || !/credit/i.test(entry.location.plugin))
    return undefined;
  const [, role, names] = /^([^\s:：]{1,12})(?:\s*[:：]\s*|\s+)(\S[^]*)$/.exec(entry.source) ?? [];
  if (!role || names === undefined || !sourceText.test(role)) return undefined;
  return { role, names: `: ${names}` };
}

/**
 * Plugin settings and MZ plugin command arguments: plugins draw them as written, so their line
 * breaks are the author's layout, unlike messages, which the engine and RPGTL wrap.
 */
export const keepsLineBreaks = ({ location }: Placed) =>
  location?._tag === "PluginSetting" ||
  (location?._tag === "CommandText" && location.parameter === 3);
