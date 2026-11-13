import { dump, load, RubyHash, RubyInteger, RubyObject } from "@hyrious/marshal";
import { type Catalog, type Entry, EventListRef, type Location } from "@rpgtl/contracts";
import * as Result from "effect/Result";
import { measuredText } from "../../controlCodes.ts";
import { entryTranslation } from "../../guesses.ts";
import { isScriptText } from "../../location.ts";
import { GameDataChanged } from "../mvmz/apply.ts";
import { GameFileInvalid } from "../mvmz/gameFile.ts";
import { scriptsFile } from "./gameFile.ts";
import { xpFileOf } from "./location.ts";
import { applyScriptTexts, type LiteralText, withTexts } from "./scripts.ts";

const utf8 = new TextDecoder();
// RGSS1 dumps strings as bytes, which load as such; Ruby 1.9 and later mark them as UTF-8, and
// those load as text. A string is written back the way it was.
const textOf = (value: unknown) =>
  value instanceof Uint8Array ? utf8.decode(value) : typeof value === "string" ? value : undefined;
const stringLike = (like: unknown, text: string) =>
  like instanceof Uint8Array ? new TextEncoder().encode(text) : text;

const ivar = (object: unknown, name: string): unknown =>
  object instanceof RubyObject ? Reflect.get(object, Symbol.for(`@${name}`)) : undefined;
const numberOf = (value: unknown) => (value instanceof RubyInteger ? value.value : undefined);
const asList = (value: unknown) => (Array.isArray(value) ? value : undefined);

// Liberation Sans, which mkxp-z draws text in when the game's font isn't there, as Chinese
// games' fonts aren't: advance widths of " " to "~" in units of 1/2048 em.
const advances =
  "569 569 727 1139 1139 1821 1366 391 682 682 797 1196 569 682 569 569 1139 1139 1139 1139 1139 1139 1139 1139 1139 1139 569 569 1196 1196 1196 1139 2079 1366 1366 1479 1479 1366 1251 1593 1479 569 1024 1366 1139 1706 1479 1593 1366 1593 1479 1366 1251 1479 1366 1933 1366 1366 1251 569 569 569 961 1139 682 1139 1139 1024 1139 1139 569 1139 1139 455 455 1024 455 1706 1139 1139 1139 1139 682 1024 569 1139 1024 1479 1024 1024 1024 684 532 684 1196"
    .split(" ")
    .map(Number);

// mkxp-z sizes a font as Windows does, so RGSS1's default size 22 is the height of a line, which
// is 2288 units of Liberation Sans: 20 pixels to the em. The default message window draws a
// character at a time, each as wide as its advance rounded to pixels.
const pixelsPerEm = 20;
// The width and rows of the default message window's text.
const lineWidth = 444;
const messageRows = 4;

// The message window draws an actor's name for \N[n] and a variable's value for \V[n], and
// wraps nothing itself, so they are measured as a long name and a few digits.
const drawnText = (text: string) =>
  measuredText(text.replace(/\\N\[\d+\]/gi, "Nnnnnnnnnn").replace(/\\V\[\d+\]/gi, "000000"));

function textWidth(text: string) {
  let width = 0;
  for (const char of drawnText(text)) {
    const code = char.codePointAt(0) ?? 0;
    width += Math.round(
      ((advances[code - 32] ?? (code > 0x2e7f ? 2048 : 1139)) * pixelsPerEm) / 2048,
    );
  }
  return width;
}

/**
 * The lines of `text` broken between words to fit the message window. A line that a break ends
 * keeps a space at its end, so that the game, measuring in its own font, can join and break them again.
 */
function wrappedLines(text: string) {
  return text.split("\n").flatMap((line) => {
    const lines: string[] = [];
    let current = "";
    for (const word of line.split(" ")) {
      const next = current ? `${current} ${word}` : word;
      if (current && textWidth(next) > lineWidth) {
        lines.push(`${current} `);
        current = word;
      } else current = next;
    }
    return [...lines, current];
  });
}

function rubyCommand(like: RubyObject, code: number, parameters: unknown[]) {
  const command = new RubyObject(like.class);
  for (const symbol of Object.getOwnPropertySymbols(like)) {
    const name = Symbol.keyFor(symbol);
    Reflect.set(
      command,
      symbol,
      name === "@code"
        ? new RubyInteger(code)
        : name === "@parameters"
          ? parameters
          : Reflect.get(like, symbol),
    );
  }
  return command;
}

/** A message's lines: the Show Text command at `index` and the 401 commands after it. */
function messageAt(list: ReadonlyArray<unknown>, index: number) {
  let end = index + 1;
  while (numberOf(ivar(list[end], "code")) === 401) end++;
  const lines = list
    .slice(index, end)
    .map((command) => textOf(asList(ivar(command, "parameters"))?.[0]) ?? "");
  return { end, text: lines.join("\n") };
}

/**
 * The commands that show `text` in place of the message from `index` to `end`: its lines
 * wrapped, in as many messages as they need, leaving room for the choices that follow.
 */
function messageCommands(list: ReadonlyArray<unknown>, index: number, end: number, text: string) {
  const first = list[index];
  if (!(first instanceof RubyObject)) return [];
  const firstLine = asList(ivar(first, "parameters"))?.[0];
  const choices = asList(asList(ivar(list[end], "parameters"))?.[0]);
  // RGSS1 shows choices in the message only when they fit below its last box's lines.
  const room = choices ? messageRows - choices.length : 0;
  const lastRows = numberOf(ivar(list[end], "code")) === 102 && room > 0 ? room : messageRows;
  const lines = wrappedLines(text);
  const messages: string[][] = [];
  while (lines.length > lastRows)
    messages.push(
      lines.splice(0, lines.length > messageRows ? messageRows : lines.length - lastRows),
    );
  messages.push(lines);
  return messages.flatMap((rows) =>
    rows.map((line, row) => rubyCommand(first, row ? 401 : 101, [stringLike(firstLine, line)])),
  );
}

/** The lines of a Script command at `index`, which the 655 commands after it continue. */
function scriptAt(list: ReadonlyArray<unknown>, index: number) {
  let end = index + 1;
  while (numberOf(ivar(list[end], "code")) === 655) end++;
  const lines = list
    .slice(index, end)
    .map((command) => textOf(asList(ivar(command, "parameters"))?.[0]) ?? "");
  return { end, code: lines.join("\n") };
}

/** The commands of a Script command whose code is now `code`, which may have more or fewer lines. */
function scriptCommands(first: unknown, code: string) {
  if (!(first instanceof RubyObject)) return [];
  const firstLine = asList(ivar(first, "parameters"))?.[0];
  return code
    .split("\n")
    .map((line, at) => rubyCommand(first, at ? 655 : 355, [stringLike(firstLine, line)]));
}

/** The commands that replace those from a message's or script's first up to `end`. */
type Replaced = { readonly end: number; readonly commands: ReadonlyArray<unknown> } | undefined;

/** The message at `index` showing `text`, if it still is `source`. */
function newMessage(
  list: ReadonlyArray<unknown>,
  index: number,
  source: string,
  text: string,
): Replaced {
  const { end, text: current } = messageAt(list, index);
  if (numberOf(ivar(list[index], "code")) !== 101 || current !== source) return undefined;
  return { end, commands: messageCommands(list, index, end, text) };
}

/** The Script command at `index` with the literals of `texts` set, if they still are their sources. */
function newScript(
  list: ReadonlyArray<unknown>,
  index: number,
  texts: ReadonlyMap<number, LiteralText>,
): Replaced {
  const { end, code } = scriptAt(list, index);
  // A request joins the line break after a `\n` code with a space, which would start the line
  // that a game breaking its text at `\n` shows.
  const lineStarts = new Map(
    [...texts].map(([at, { source, text }]) => [
      at,
      { source, text: text.replace(/\\n[^\S\n]+/g, "\\n") },
    ]),
  );
  const changed =
    numberOf(ivar(list[index], "code")) === 355 ? withTexts(code, lineStarts) : undefined;
  return changed === undefined
    ? undefined
    : { end, commands: scriptCommands(list[index], changed) };
}

/** The item with id `id` of a list, or of a hash by id such as a map's events. */
const itemAt = (items: unknown, id: number) =>
  items instanceof RubyHash
    ? items.entries.find(([key]) => numberOf(key) === id)?.[1]
    : asList(items)?.[id];

const pageList = (owner: unknown, page: number) =>
  asList(ivar(asList(ivar(owner, "pages"))?.[page], "list"));

/** The event commands of `list` in the file's data. */
const commandsOf = (data: unknown, list: EventListRef) =>
  EventListRef.match(list, {
    MapEventPage: ({ event, page }) => pageList(itemAt(ivar(data, "events"), event), page),
    CommonEvent: ({ event }) => asList(ivar(itemAt(data, event), "list")),
    TroopPage: ({ troop, page }) => pageList(itemAt(data, troop), page),
  });

/**
 * Sets the text at `location` to `text`, in place, if it still is `source`. Messages and scripts
 * are left out, since they change the length of their list.
 */
function setText(data: unknown, location: Location, source: string, text: string): boolean {
  const set = (holder: unknown, key: string | number) => {
    const current = typeof key === "number" ? asList(holder)?.[key] : ivar(holder, key);
    if (textOf(current) !== source) return false;
    if (typeof key === "number") Reflect.set(asList(holder) ?? [], key, stringLike(current, text));
    else Reflect.set(holder ?? {}, Symbol.for(`@${key}`), stringLike(current, text));
    return true;
  };
  switch (location._tag) {
    case "CommandText": {
      const parameters = asList(
        ivar(commandsOf(data, location.list)?.[location.index], "parameters"),
      );
      const [key] = location.keys;
      return key === undefined
        ? set(parameters, location.parameter)
        : set(asList(parameters?.[location.parameter]), Number(key));
    }
    case "RecordField":
      return set(itemAt(data, location.record), location.field);
    case "SystemText": {
      const [group, key] = location.keys;
      if (group === undefined || key === undefined) return false;
      const holder = ivar(data, group);
      return Array.isArray(holder) ? set(holder, Number(key)) : set(holder, key);
    }
    default:
      return false;
  }
}

/**
 * The translated entries of an XP game by the data file that holds their text, such as
 * `Map001.rxdata`, and its scripts, which get the script that fits the English, unless it plays
 * them unchanged.
 */
export function translatedByXpFile({ entries, originalScripts }: Catalog) {
  const files = new Map<string, Array<Entry>>(originalScripts ? [] : [[scriptsFile, []]]);
  for (const entry of entries) {
    if (originalScripts && isScriptText(entry)) continue;
    const file = xpFileOf(entry.location);
    if (file === undefined || !entryTranslation(entry) || entry.keepOriginal) continue;
    const listed = files.get(file);
    if (listed) listed.push(entry);
    else files.set(file, [entry]);
  }
  return files;
}

/**
 * The XP data file `file` (such as `Map001.rxdata`) with the entries' translations in it; none
 * when no entry of the file is translated, except for `Scripts.rxdata`, which always gets the
 * script that fits English. Messages are wrapped to fit the default message window. Fails when
 * the file no longer holds an entry's source.
 */
export function applyXpTranslations(
  file: string,
  bytes: Uint8Array,
  entries: ReadonlyArray<Entry>,
): Result.Result<Uint8Array | undefined, GameDataChanged | GameFileInvalid> {
  const translated = entries.flatMap((entry) => {
    const text = entryTranslation(entry);
    return text && !entry.keepOriginal && xpFileOf(entry.location) === file
      ? [{ entry, text }]
      : [];
  });
  if (file === scriptsFile) {
    const texts = new Map<number, Map<number, LiteralText>>();
    for (const { entry, text } of translated) {
      if (entry.location._tag !== "RubyScriptText") continue;
      const { script, literal } = entry.location;
      const literals = texts.get(script) ?? new Map<number, LiteralText>();
      texts.set(script, literals.set(literal, { source: entry.source, text }));
    }
    return applyScriptTexts(file, bytes, texts);
  }
  if (!translated.length) return Result.succeed(undefined);
  return Result.try({
    try: () => load(bytes, { hash: "wrap", numeric: "wrap", regexp: "wrap" }),
    catch: (error) => new GameFileInvalid({ file, problem: String(error) }),
  }).pipe(
    Result.flatMap((data) => {
      const replaced: Array<{ list: unknown[]; index: number; commands: () => Replaced }> = [];
      const scripts = new Map<unknown[], Map<number, Map<number, LiteralText>>>();
      for (const { entry, text } of translated) {
        const { location } = entry;
        if (location._tag === "Message" || location._tag === "ScriptText") {
          const list = commandsOf(data, location.list);
          if (!list) return Result.fail(new GameDataChanged({ file }));
          const { index } = location;
          if (location._tag === "Message")
            replaced.push({
              list,
              index,
              commands: () => newMessage(list, index, entry.source, text),
            });
          else {
            const inList = scripts.get(list) ?? new Map<number, Map<number, LiteralText>>();
            const literals = inList.get(index);
            if (literals) literals.set(location.literal, { source: entry.source, text });
            else {
              const first = new Map([[location.literal, { source: entry.source, text }]]);
              scripts.set(list, inList.set(index, first));
              replaced.push({ list, index, commands: () => newScript(list, index, first) });
            }
          }
        } else if (!setText(data, location, entry.source, text))
          return Result.fail(new GameDataChanged({ file }));
      }
      // From the end of each list, so that the indexes of the changes before stay.
      for (const { list, index, commands } of replaced.toSorted((a, b) => b.index - a.index)) {
        const changed = commands();
        if (!changed) return Result.fail(new GameDataChanged({ file }));
        list.splice(index, changed.end - index, ...changed.commands);
      }
      return Result.succeed(dump(data));
    }),
  );
}
