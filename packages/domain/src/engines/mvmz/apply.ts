import type {
  Entry,
  EventCommand,
  EventList,
  EventListRef,
  ImageReplacement,
  ImageTextHint,
  Location,
  MessageLayout,
  Plugins,
  ServedMap,
  ServedSystem,
  Table,
} from "@rpgtl/contracts";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { measuredText } from "../../controlCodes.ts";
import { messageRun } from "./extract.ts";
import { listFocus, pluginFocus, textFocus } from "./focus.ts";
import { GameFile } from "./gameFile.ts";
import { isMessage, listKey } from "../../location.ts";
import { fileOf } from "./location.ts";
import { givenNameTranslation } from "../../shortNames.ts";
import { entryTranslation } from "../../guesses.ts";

export class GameDataChanged extends Schema.TaggedError<GameDataChanged>()("GameDataChanged", {
  file: Schema.String,
}) {
  override get message() {
    return "Game data changed. Inspect the game again.";
  }
}

// Chinese and Japanese characters are about twice as wide as Latin ones.
function width(text: string) {
  let sum = 0;
  for (const char of text) sum += char > "\u2e7f" ? 2 : 1;
  return sum;
}

const widestLines = 20;

// Messages centred in the same frame start a few spaces apart.
const frameTolerance = 4;

/**
 * Where messages positioned inside picture frames using spaces and blank rows put their text.
 * Messages that start at about the same indent share a frame, so each gets the frame's left edge,
 * the lowest row of all of them and the frame's longest lines. Counting characters can't tell
 * which of them is widest, since dots and Latin letters are narrower, so the runtime
 * measures them in the game's font. Layouts are looked up by the translation with its indent, as
 * the same words may stand in different frames.
 */
export function messageLayouts(entries: ReadonlyArray<Entry>) {
  const messages: { key: string | undefined; first: number; edge: number; lines: string[] }[] = [];
  const counts = new Map<number, number>();
  for (const entry of entries) {
    if (!isMessage(entry)) continue;
    const lines = entry.source.split("\n");
    const first = lines.findIndex((line) => line.trim());
    const content = lines.slice(first).filter((line) => line.trim());
    const indent = Math.min(...content.map((line) => /^ */.exec(line)?.[0].length ?? 0));
    if (first < 1 || indent < 8) continue;
    const key = entryTranslation(entry).trimEnd() || undefined;
    messages.push({ key, first, edge: indent, lines: content.map((l) => measuredText(l.trim())) });
    counts.set(indent, (counts.get(indent) ?? 0) + 1);
  }
  // The most common indents are the frames' left edges; the others join the nearest one.
  const edges: number[] = [];
  const edgeOf = new Map<number, number>();
  for (const [indent] of [...counts].toSorted((a, b) => b[1] - a[1] || a[0] - b[0])) {
    const near = edges
      .filter((edge) => Math.abs(edge - indent) <= frameTolerance)
      .toSorted((a, b) => Math.abs(a - indent) - Math.abs(b - indent))[0];
    if (near === undefined) edges.push(indent);
    edgeOf.set(indent, near ?? indent);
  }
  for (const message of messages) message.edge = edgeOf.get(message.edge) ?? message.edge;
  const frames = new Map<number, { lines: string[]; bottom: number; widest: string[] }>();
  for (const { first, edge, lines } of messages) {
    const frame = frames.get(edge) ?? { lines: [], bottom: 0, widest: [] };
    frame.lines.push(...lines);
    frame.bottom = Math.max(frame.bottom, first + lines.length);
    frames.set(edge, frame);
  }
  for (const frame of frames.values())
    frame.widest = [...new Set(frame.lines)]
      .toSorted((a, b) => width(b) - width(a))
      .slice(0, widestLines);
  const sources = new Map<string, { first: number; edge: number }>();
  const ambiguous = new Set<string>();
  for (const { key, first, edge } of messages) {
    if (!key) continue;
    const previous = sources.get(key);
    if (previous && (previous.first !== first || previous.edge !== edge)) ambiguous.add(key);
    else sources.set(key, { first, edge });
  }
  const layouts: Record<string, MessageLayout> = Object.create(null);
  for (const [key, { first, edge }] of sources) {
    const frame = frames.get(edge);
    if (ambiguous.has(key) || !frame) continue;
    layouts[key] = {
      top: first,
      indent: " ".repeat(edge),
      widest: frame.widest,
      rows: frame.bottom - first,
    };
  }
  return layouts;
}

/**
 * Images whose names hold translated text, by the name the translated game asks for. Plugins such
 * as MOG_BattleCommands load `Com_` plus a command's name, so once the skill type 魔法技能 is
 * translated the game asks for Com_<translation>, and these load Com_魔法技能 in its place. Only
 * names whose other characters are ASCII count, as a plugin adds such a prefix or suffix.
 * `files` are paths under the game's web root, such as `img/battlecommands/Com_魔法技能.rpgmvp`.
 */
export function translatedImageNames(files: ReadonlyArray<string>, entries: ReadonlyArray<Entry>) {
  const nonAscii = /[^ -~]+/;
  const translations = new Map<string, Set<string>>();
  for (const entry of entries) {
    const { source } = entry;
    const translation = entryTranslation(entry);
    if (translation && nonAscii.exec(source)?.[0] === source)
      translations.set(source, (translations.get(source) ?? new Set()).add(translation));
  }
  const existing = new Set(files.map((file) => file.replace(/\.[^./]+$/, "")));
  const images: Record<string, ImageReplacement> = {};
  for (const file of files) {
    const [, folder, name] = /^(img\/(?:.*\/)?)([^/]+)\.[^./]+$/.exec(file) ?? [];
    if (folder === undefined || name === undefined) continue;
    const text = nonAscii.exec(name)?.[0];
    if (!text || nonAscii.test(name.replace(text, ""))) continue;
    for (const translation of translations.get(text) ?? []) {
      const asked = folder + name.replace(text, () => translation);
      if (!existing.has(asked)) images[asked] = { file: name };
    }
  }
  return images;
}

type NameGroup = "events" | "switches" | "variables";

/** The name an event, switch or variable has in the file. */
function currentName(file: GameFile, group: NameGroup, id: number): unknown {
  if (group === "events") return file._tag === "Map" ? file.data.events[id]?.name : undefined;
  if (file._tag !== "System") return undefined;
  const names = file.data[group];
  return Array.isArray(names) ? names[id] : undefined;
}

/** The list with the messages starting at the given indices replaced by their translations. */
function translateMessages(list: EventList, messages: ReadonlyMap<number, Entry>) {
  const translated: EventCommand[] = [];
  let found = 0;
  for (let index = 0; index < list.length; index++) {
    const command = list[index];
    const entry = messages.get(index);
    const run = entry && messageRun(list, index);
    if (!command) continue;
    if (!entry) {
      translated.push(command);
      continue;
    }
    if (!run || run.source !== entry.source) return Option.none();
    found++;
    translated.push({
      ...command,
      parameters: [entryTranslation(entry), ...command.parameters.slice(1)],
    });
    index = run.end - 1;
  }
  return found === messages.size ? Option.some(translated) : Option.none();
}

// Script text in a variable, an actor's name, nickname or profile, or the text of Change Name,
// Change Nickname or Change Profile (which shares its parameter index with When [choice]).
const isSaveText = (location: Location) =>
  location._tag === "ScriptText" ||
  (location._tag === "RecordField" && location.table === "actors") ||
  (location._tag === "CommandText" && location.parameter === 1 && location.keys.length === 0);

const isRecordName = (table: Table) => (entry: Entry) =>
  entry.location._tag === "RecordField" &&
  entry.location.table === table &&
  entry.location.field === "name" &&
  !!entryTranslation(entry);

/** The images System.json tells the runtime to replace or draw English into. */
export interface SystemImages {
  /** Images to load in place of missing ones, by the path the game asks for. */
  readonly images?: Readonly<Record<string, ImageReplacement>> | undefined;
  /** Images to erase and draw the English into as they load, by image path. */
  readonly imageText?: Readonly<Record<string, ImageTextHint>> | undefined;
}

/** System.json with the images to load in place of missing ones and to draw English into. */
export function withSystemImages(
  system: Extract<GameFile, { readonly _tag: "System" }>,
  { images, imageText }: SystemImages,
) {
  const added: ServedSystem = {
    ...(images && Object.keys(images).length && { rpgtlImages: images }),
    ...(imageText && Object.keys(imageText).length && { rpgtlImageText: imageText }),
  };
  return GameFile.System({ data: { ...system.data, ...added } });
}

/** What the runtime reads from System.json besides its text, for all of the entries. */
function systemExtras(entries: ReadonlyArray<Entry>) {
  const extras: Types.Mutable<ServedSystem> = {};
  const layouts = messageLayouts(entries);
  if (Object.keys(layouts).length) extras.rpgtlMessageLayouts = layouts;
  const saveText = Object.fromEntries(
    entries.flatMap((entry) =>
      entryTranslation(entry) && isSaveText(entry.location)
        ? [[entry.source, entryTranslation(entry)]]
        : [],
    ),
  );
  if (Object.keys(saveText).length) extras.rpgtlSaveText = saveText;
  const shortNames: Record<string, { source: string; short: string }> = {};
  for (const entry of entries.filter(isRecordName("actors"))) {
    const short = givenNameTranslation(entry.source, entryTranslation(entry), entries);
    if (short) shortNames[entryTranslation(entry)] = { source: entry.source, short };
  }
  if (Object.keys(shortNames).length) extras.rpgtlShortNames = shortNames;
  const classNames = Object.fromEntries(
    entries.filter(isRecordName("classes")).map((entry) => [entryTranslation(entry), entry.source]),
  );
  if (Object.keys(classNames).length) extras.rpgtlClassNames = classNames;
  return extras;
}

/**
 * The data file `file` with the entries' translations in it, and what the runtime, the map
 * view and the F8 panel read from the served file. Fails when the file no longer holds an entry's
 * source.
 */
export function applyTranslations(
  file: string,
  data: GameFile,
  entries: ReadonlyArray<Entry>,
): Result.Result<GameFile, GameDataChanged> {
  const changed = Result.fail(new GameDataChanged({ file }));
  const names: Partial<Record<NameGroup, Record<string, string>>> = {};
  const messages = new Map<string, { list: EventListRef; byIndex: Map<number, Entry> }>();
  let commandsTranslated = false;
  let translated = data;
  for (const entry of entries) {
    const { location } = entry;
    if (!entryTranslation(entry) || fileOf(location) !== file) continue;
    if (location._tag === "EventName") {
      if (currentName(data, "events", location.event) === entry.source)
        (names.events ??= {})[location.event] = entryTranslation(entry);
      continue;
    }
    if (location._tag === "Name") {
      if (currentName(data, location.group, location.id) === entry.source)
        (names[location.group] ??= {})[location.id] = entryTranslation(entry);
      continue;
    }
    if (location._tag === "Message") {
      const key = listKey(location.list);
      const list = messages.get(key) ?? { list: location.list, byIndex: new Map() };
      list.byIndex.set(location.index, entry);
      messages.set(key, list);
      continue;
    }
    if (
      location._tag === "SystemText" &&
      location.keys[0] === "terms" &&
      location.keys[1] === "commands"
    )
      commandsTranslated = true;
    const next = Option.flatMap(textFocus(location, entry.source), (focus) =>
      Result.getSuccess(focus.replaceResult(entryTranslation(entry), translated)),
    );
    if (Option.isNone(next)) return changed;
    translated = next.value;
  }
  for (const { list, byIndex } of messages.values()) {
    const focus = listFocus(list);
    const next = Result.getSuccess(focus.getResult(translated)).pipe(
      Option.flatMap((commands) => translateMessages(commands, byIndex)),
      Option.flatMap((commands) => Result.getSuccess(focus.replaceResult(commands, translated))),
    );
    if (Option.isNone(next)) return changed;
    translated = next.value;
  }
  const added: ServedSystem | ServedMap = {
    ...(commandsTranslated && { rpgtlCommandsTranslated: true }),
    ...(translated._tag === "System" && systemExtras(entries)),
    ...(Object.keys(names).length && { rpgtlNames: names }),
  };
  if (!Object.keys(added).length) return Result.succeed(translated);
  if (translated._tag === "System")
    return Result.succeed(GameFile.System({ data: { ...translated.data, ...added } }));
  if (translated._tag === "Map")
    return Result.succeed(
      GameFile.Map({ map: translated.map, data: { ...translated.data, ...added } }),
    );
  return Result.succeed(translated);
}

/** The plugin list with the translations of plugin settings in it. */
export function applyPluginTranslations(
  plugins: Plugins,
  entries: ReadonlyArray<Entry>,
): Result.Result<Plugins, GameDataChanged> {
  let translated = plugins;
  for (const entry of entries) {
    if (entry.location._tag !== "PluginSetting" || !entryTranslation(entry)) continue;
    const { plugin, keys } = entry.location;
    const next = Option.flatMap(pluginFocus(translated, plugin, keys, entry.source), (focus) =>
      Result.getSuccess(focus.replaceResult(entryTranslation(entry), translated)),
    );
    if (Option.isNone(next)) return Result.fail(new GameDataChanged({ file: "js/plugins.js" }));
    translated = next.value;
  }
  return Result.succeed(translated);
}
