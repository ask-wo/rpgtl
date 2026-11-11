import type { Catalog, LogicUse, MissingText, Plugins } from "@rpgtl/contracts";
import * as Predicate from "effect/Predicate";
import {
  decodeJson,
  isDrawnTag,
  noteTags,
  pluginParameters,
  sourceText,
  variableStrings,
} from "./extract.ts";
import { entryTranslation } from "./guesses.ts";

/** Every data file of a game and its plugins, for searches of all of it. */
export interface GameContents {
  /** Each `data/*.json` file, sorted by name, whether RPGTL extracts its text or not. */
  readonly dataFiles: ReadonlyArray<{ readonly name: string; readonly data: unknown }>;
  readonly plugins: Plugins;
  /** The code of each plugin js/plugins.js lists, by name, when its file is there. */
  readonly pluginCode: ReadonlyMap<string, string>;
}

const fileKind = (file: string) => file.replace(/\d+/, "*");

/** An event command, whose parameters are where the text in an event is. */
const isCommand = (node: {
  readonly [key: PropertyKey]: unknown;
}): node is { readonly [key: PropertyKey]: unknown } & {
  readonly code: number;
  readonly parameters: ReadonlyArray<unknown>;
} => Number.isInteger(node.code) && Array.isArray(node.parameters);

// Event and move route command code -> indexes of parameters that name a picture, sound, movie or
// character image.
const fileParameters: Partial<Record<number, ReadonlyArray<number>>> = {
  41: [0], // Move route: Change Image
  44: [0], // Move route: Play SE
  101: [0], // Show Text: face
  132: [0],
  133: [0],
  139: [0],
  140: [1],
  231: [1],
  241: [0],
  245: [0],
  249: [0],
  250: [0],
  261: [0],
  283: [0, 1],
  284: [0],
  322: [1, 3, 5],
  323: [1],
};
const fileFields = new Set([
  "characterName",
  "faceName",
  "battlerName",
  "battleback1Name",
  "battleback2Name",
  "parallaxName",
  "tilesetNames",
  "title1Name",
  "title2Name",
  "animation1Name",
  "animation2Name",
  "effectName",
]);
// In these files a `name` is a sound's file name or a name only the editor shows.
const editorNameFiles = new Set([
  "Animations.json",
  "CommonEvents.json",
  "MapInfos.json",
  "Map*.json",
  "System.json",
  "Tilesets.json",
  "Troops.json",
]);

/** A note's tags with values, one per line, and the text around them. */
function splitNote(note: string) {
  const spans = noteTags(note).map(({ start, end }) => ({
    start: note.lastIndexOf("<", start),
    end: end + 1,
  }));
  return {
    tags: spans.map(({ start, end }) => note.slice(start, end)).join("\n"),
    rest: spans.reduceRight((text, { start, end }) => text.slice(0, start) + text.slice(end), note),
  };
}

/**
 * Calls `visit` with every string in a data file, where it is (an event command's parameter, or
 * the field that holds it) and whether the game may show it: file names and names only the
 * editor shows are never shown.
 */
function visitStrings(
  file: string,
  data: unknown,
  visit: (text: string, where: string, shown: boolean) => void,
) {
  const kind = fileKind(file);
  const walk = (node: unknown, where: string, shown: boolean): void => {
    if (Predicate.isString(node)) visit(node, where, shown);
    else if (Array.isArray(node)) for (const item of node) walk(item, where, shown);
    else if (Predicate.isObject(node)) {
      if (isCommand(node)) {
        for (const [index, parameter] of node.parameters.entries())
          walk(
            parameter,
            `${kind} code ${node.code} parameter ${index}`,
            !fileParameters[node.code]?.includes(index),
          );
        return;
      }
      for (const [key, value] of Object.entries(node))
        if (where.includes(" code ")) walk(value, where, shown);
        else if (key === "note" && Predicate.isString(value)) {
          const { tags, rest } = splitNote(value);
          visit(tags, `${kind} note`, true);
          // Plugins such as YEP_ItemCore draw the text between block tags like `<Help Description>`.
          if (/<\/[^<>\n]+>/.test(rest)) visit(rest, `${kind} note`, true);
          else visit(rest, `${kind} note outside tags`, false);
        } else
          walk(
            value,
            `${kind} ${key}`,
            !fileFields.has(key) && !(key === "name" && editorNameFiles.has(kind)),
          );
    }
  };
  walk(data, kind, true);
}

/** Strings in plugin settings, looking inside lists and structs stored as JSON text. */
function visitPluginStrings(value: unknown, visit: (text: string) => void): void {
  if (Predicate.isString(value)) {
    const inner = /^\s*[[{]/.test(value) ? decodeJson(value) : undefined;
    if (inner?._tag === "Some") visitPluginStrings(inner.value, visit);
    else visit(value);
  } else if (Predicate.isObjectOrArray(value))
    for (const item of Object.values(value)) visitPluginStrings(item, visit);
}

/**
 * Chinese, Japanese or Korean text in the game's data files and enabled plugins' settings that no
 * catalog entry covers, grouped by where it is: groups the game may show first, then those of
 * file names and names only the editor shows, each most first. Comments belong here too; the
 * rest is text extraction misses. `listed` are the data files RPGTL reads.
 */
export function missingText(
  contents: GameContents,
  listed: ReadonlyArray<string>,
  catalog: Pick<Catalog, "entries">,
): ReadonlyArray<MissingText> {
  const covered = new Set(catalog.entries.flatMap((entry) => entry.source.split("\n")));
  const sources = new Set(catalog.entries.map((entry) => entry.source));
  // Variable text in a script and drawn text in a note tag are their own entries, so the rest of
  // the script or note is what may be missing. A tag goes whole, since its key may be CJK too.
  const withoutOwnText = (text: string) =>
    [
      ...variableStrings(text),
      ...noteTags(text).map(({ start, end, value }) => ({
        start: text.lastIndexOf("<", start),
        end: end + 1,
        value,
      })),
    ]
      .toSorted((a, b) => b.start - a.start)
      .reduce(
        (rest, { start, end, value }) =>
          sources.has(value) ? rest.slice(0, start) + rest.slice(end) : rest,
        text,
      );
  const isMissing = (text: string) =>
    withoutOwnText(text)
      .split("\n")
      .some((line) => sourceText.test(line) && !covered.has(line));
  const groups = new Map<string, { shown: boolean; count: number; examples: Set<string> }>();
  const add = (where: string, text: string, shown: boolean) => {
    if (!isMissing(text)) return;
    const group = groups.get(where) ?? { shown, count: 0, examples: new Set<string>() };
    groups.set(where, group);
    group.count++;
    if (group.examples.size < 5) group.examples.add(text);
  };
  const read = new Set(listed);
  for (const { name, data } of contents.dataFiles) {
    const note = read.has(name) ? "" : " (file not read by RPGTL)";
    visitStrings(name, data, (text, where, shown) => add(where + note, text, shown));
  }
  for (const [name, parameters] of pluginParameters(contents.plugins))
    visitPluginStrings(parameters, (text) => add(`plugins.js ${name}`, text, true));
  return [...groups]
    .map(([where, { shown, count, examples }]) => ({
      where,
      shown,
      count,
      examples: [...examples],
    }))
    .toSorted(
      (a, b) =>
        Number(b.shown) - Number(a.shown) || b.count - a.count || a.where.localeCompare(b.where),
    );
}

const stringLiteral = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`\\]*)`/g;

/** The values of the string literals in code, leaving out the variable text RPGTL translates. */
function literals(code: string) {
  const own = variableStrings(code);
  return [...code.matchAll(stringLiteral)]
    .filter((match) => !own.some(({ start }) => start === match.index))
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

// A drawn tag's value is its own entry, which would otherwise match its own translation.
const withoutDrawnTags = (note: string) =>
  noteTags(note).reduceRight(
    (text, { start, end, value }) =>
      isDrawnTag(value) ? text.slice(0, start) + text.slice(end) : text,
    note,
  );

const words = (text: string) => text.split(/[\s<>:,;=[\]"'()]+/);

/**
 * Translated text that game logic also uses as a value: string literals in event scripts, script
 * conditions and variable operands, move route scripts and plugin code, words in MV plugin
 * commands and notes, and actor names in Conditional Branch. The game then compares or looks up
 * the original text while it sees the translation, or the other way around.
 */
export function textInLogic(
  contents: GameContents,
  catalog: Pick<Catalog, "entries">,
): ReadonlyArray<LogicUse> {
  const translations = new Map<string, string>();
  for (const entry of catalog.entries) {
    const translation = entryTranslation(entry);
    if (translation && translation !== entry.source && sourceText.test(entry.source))
      translations.set(entry.source, translation);
  }
  const uses: Array<LogicUse> = [];
  const check = (where: string, line: string, texts: ReadonlyArray<string>) => {
    for (const text of new Set(texts)) {
      const translation = translations.get(text);
      if (translation !== undefined) uses.push({ where, text, translation, line: line.trim() });
    }
  };
  for (const { name, data } of contents.dataFiles) {
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!Predicate.isObject(node)) return;
      if (isCommand(node)) {
        const { code, parameters: p } = node;
        const where = `${fileKind(name)} code ${code}`;
        const script = (value: unknown) => {
          if (Predicate.isString(value)) check(where, value, literals(value));
        };
        if (code === 355 || code === 655 || code === 45) script(p[0]);
        if (code === 111 && p[0] === 12) script(p[1]);
        if (code === 122 && p[3] === 4) script(p[4]);
        const command = p[0];
        if (code === 356 && Predicate.isString(command)) check(where, command, words(command));
        // Conditional Branch: actor's name is …
        const actorName = p[3];
        if (code === 111 && p[0] === 4 && p[2] === 1 && Predicate.isString(actorName))
          check(where, actorName, [actorName]);
      }
      if (Predicate.isString(node.note))
        check(`${fileKind(name)} note`, node.note, words(withoutDrawnTags(node.note)));
      for (const value of Object.values(node)) walk(value);
    };
    walk(data);
  }
  for (const plugin of contents.plugins) {
    const code = plugin?.status ? contents.pluginCode.get(plugin.name) : undefined;
    if (!plugin || code === undefined) continue;
    for (const line of code.replace(/\/\*[^]*?\*\//g, "").split("\n"))
      check(`js/plugins/${plugin.name}.js`, line.slice(0, 200), literals(line));
  }
  return uses;
}
