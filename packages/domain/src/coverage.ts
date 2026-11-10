import type { Catalog, LogicUse, MissingText, Plugins } from "@rpgtl/contracts";
import * as Predicate from "effect/Predicate";
import { decodeJson, noteTags, pluginParameters, sourceText, variableStrings } from "./extract.ts";
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

/**
 * Calls `visit` with every string in a data file and where it is: an event command's parameter,
 * or the field that holds it.
 */
function visitStrings(file: string, data: unknown, visit: (text: string, where: string) => void) {
  const walk = (node: unknown, where: string): void => {
    if (Predicate.isString(node)) visit(node, where);
    else if (Array.isArray(node)) for (const item of node) walk(item, where);
    else if (Predicate.isObject(node)) {
      if (isCommand(node)) {
        for (const [index, parameter] of node.parameters.entries())
          walk(parameter, `${fileKind(file)} code ${node.code} parameter ${index}`);
        return;
      }
      for (const [key, value] of Object.entries(node))
        walk(value, where.includes(" code ") ? where : `${fileKind(file)} ${key}`);
    }
  };
  walk(data, fileKind(file));
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
 * catalog entry covers, grouped by where it is, most first. Comments, file names and names only
 * the editor shows belong here too; the rest is text extraction misses. `listed` are the data
 * files RPGTL reads.
 */
export function missingText(
  contents: GameContents,
  listed: ReadonlyArray<string>,
  catalog: Pick<Catalog, "entries">,
): ReadonlyArray<MissingText> {
  const covered = new Set(catalog.entries.flatMap((entry) => entry.source.split("\n")));
  // Variable text in a script and drawn text in a note tag are their own entries, so the rest of
  // the script or note is what may be missing.
  const withoutOwnText = (text: string) =>
    [...variableStrings(text), ...noteTags(text)]
      .toSorted((a, b) => b.start - a.start)
      .reduce(
        (rest, { start, end, value }) =>
          covered.has(value) ? rest.slice(0, start) + rest.slice(end) : rest,
        text,
      );
  const isMissing = (text: string) =>
    withoutOwnText(text)
      .split("\n")
      .some((line) => sourceText.test(line) && !covered.has(line));
  const groups = new Map<string, { count: number; examples: Set<string> }>();
  const add = (where: string, text: string) => {
    if (!isMissing(text)) return;
    const group = groups.get(where) ?? { count: 0, examples: new Set<string>() };
    groups.set(where, group);
    group.count++;
    if (group.examples.size < 5) group.examples.add(text);
  };
  const read = new Set(listed);
  for (const { name, data } of contents.dataFiles) {
    const note = read.has(name) ? "" : " (file not read by RPGTL)";
    visitStrings(name, data, (text, where) => add(where + note, text));
  }
  for (const [name, parameters] of pluginParameters(contents.plugins))
    visitPluginStrings(parameters, (text) => add(`plugins.js ${name}`, text));
  return [...groups]
    .map(([where, { count, examples }]) => ({ where, count, examples: [...examples] }))
    .toSorted((a, b) => b.count - a.count || a.where.localeCompare(b.where));
}

const stringLiteral = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`\\]*)`/g;

/** The values of the string literals in code, leaving out the variable text RPGTL translates. */
function literals(code: string) {
  const own = variableStrings(code);
  return [...code.matchAll(stringLiteral)]
    .filter((match) => !own.some(({ start }) => start === match.index))
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

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
        check(`${fileKind(name)} note`, node.note, words(node.note));
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
