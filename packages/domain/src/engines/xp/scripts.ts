import { dump, load } from "@hyrious/marshal";
import type { Location } from "@rpgtl/contracts";
import { unzlibSync, zlibSync } from "fflate";
import * as Result from "effect/Result";
import { sourceText } from "../mvmz/extract.ts";
import { GameFile, GameFileInvalid } from "../mvmz/gameFile.ts";
import { GameDataChanged } from "../mvmz/apply.ts";
import { englishBranches, holdsSource } from "./englishBranches.ts";
import { type RubyLiteral, rubyLiterals } from "./rubyLiterals.ts";
import { xpImageScript } from "./images.ts";
import { textFittingScript } from "./textFitting.ts";

const utf8 = new TextDecoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** A script of `Scripts.rxdata`. */
export interface RubyScript {
  readonly name: string;
  readonly code: string;
}

/**
 * The entries of `Scripts.rxdata`: `[id, name, code]`, the code zlib-compressed. A name that
 * Ruby 1.9 or later wrote is marked as UTF-8 and loads as a string.
 */
function scriptRows(file: string, bytes: Uint8Array) {
  return Result.try({
    try: () => {
      const rows = load(bytes, { numeric: "wrap" });
      if (!Array.isArray(rows)) throw new Error("it isn't a list of scripts");
      return rows.map((row: unknown) => {
        if (
          !Array.isArray(row) ||
          !(row[1] instanceof Uint8Array || typeof row[1] === "string") ||
          !(row[2] instanceof Uint8Array)
        )
          throw new Error("a script isn't [id, name, code]");
        return row;
      });
    },
    catch: (error) => new GameFileInvalid({ file, problem: String(error) }),
  });
}

const nameOf = (name: string | Uint8Array) => (typeof name === "string" ? name : utf8.decode(name));

/**
 * A script's code; none when it doesn't decompress, or isn't UTF-8 as RGSS reads it, since
 * writing it back would change its other bytes. Such a script has no text.
 */
function codeOf(compressed: Uint8Array) {
  try {
    return strictUtf8.decode(unzlibSync(compressed));
  } catch {
    return undefined;
  }
}

/** Reads `Scripts.rxdata` from its bytes. */
export const decodeXpScripts = (file: string, bytes: Uint8Array) =>
  Result.flatMap(scriptRows(file, bytes), (rows) =>
    Result.try({
      try: () =>
        GameFile.Scripts({
          data: rows.map((row) => ({
            name: nameOf(row[1]),
            code: codeOf(row[2]) ?? "",
          })),
        }),
      catch: (error) => new GameFileInvalid({ file, problem: String(error) }),
    }),
  );

const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", s: " " };

// Code a double-quoted literal runs and shows the value of, such as `#{@gold}`; one with braces
// inside isn't recognised, so its literal isn't read.
const interpolation = /#\{[^{}]*\}/g;

/**
 * The text of a Ruby string literal, with each `#{}` in it kept as it is; none for one whose
 * text isn't plain, such as one with an escape like `\e` or `#@name` in it.
 */
export function literalText(literal: string) {
  const body = literal.slice(1, -1);
  if (literal.startsWith("'")) return body.replace(/\\([\\'])/g, "$1");
  let plain = true;
  const parts = body.split(/(#\{[^{}]*\})/).map((part, at) => {
    if (at % 2) return part;
    if (/#[{$@]/.test(part)) plain = false;
    return part.replace(/\\(.)/gs, (_, char: string) => {
      // Ruby reads a backslash before punctuation as that character.
      if (!/[\w\n]/.test(char)) return char;
      const unescaped = escapes[char];
      if (unescaped === undefined) plain = false;
      return unescaped ?? char;
    });
  });
  return plain ? parts.join("") : undefined;
}

/** A Ruby string literal of `text` in the quotes `like` uses, with the `#{}` that `like` has kept as code. */
function rubyLiteral(text: string, like: string) {
  if (like.startsWith("'")) return `'${text.replace(/[\\']/g, "\\$&")}'`;
  const kept = new Set(like.match(interpolation));
  const escaped = text
    .split(/(#\{[^{}]*\})/)
    .map((part, at) =>
      at % 2 && kept.has(part)
        ? part
        : part
            .replace(/[\\"]/g, "\\$&")
            .replace(/#(?=[{$@])/g, "\\#")
            .replace(/\n/g, "\\n")
            .replace(/\t/g, "\\t"),
    )
    .join("");
  return `"${escaped}"`;
}

// Calls whose string arguments name a file, font or system function rather than show text.
const nameCall =
  /(?:\bRPG::Cache\.\w+|\bAudio\.\w+|\bFile\.\w+|\bFileTest\.\w+|\bDir\.\w+|\bFont\.\w+|\bload_data|\bsave_data|\bBitmap\.new|\bWin32API\.new|\brequire|\bGraphics\.transition|\bRPG::AudioFile\.new)\s*(\(?)([^]*)$/;
// Output meant for the game's author, such as `p "no such item"`, which shows a message box.
const debugCall = /^\s*(?:p|pp|print|puts|raise|fail|warn|msgbox|msgbox_p)(?:\s+(?![=.])|\()/;
const fontName = /\bfont\.name\s*=[^;]*$/;
// RGSS's fields that name a graphic, and showing a picture, which loads the file it names.
const fileField =
  /\b(?:(?:character|battler|picture|windowskin|title|gameover|battleback|panorama|fog|tileset|icon)_name|battle_transition)\s*=\s*$|\bpictures\[[^\]]*\]\.show\(\s*$/;

/** Whether the code before a literal on its line passes the literal to output or a file name. */
function isNameOrOutput(before: string) {
  if (debugCall.test(before) || fontName.test(before) || fileField.test(before)) return true;
  const call = nameCall.exec(before);
  if (!call) return false;
  let depth = call[1] ? 1 : 0;
  for (const char of call[2] ?? "") {
    if (char === "(") depth++;
    else if (char === ")" && --depth < 0) return false;
    else if (char === ";") return false;
  }
  return !call[1] || depth > 0;
}

/**
 * The literals of a script that are a character table, such as a name input's: 10 or more
 * literals in a list of one character or none each.
 */
function characterTables(code: string, literals: ReadonlyArray<RubyLiteral>) {
  const inTables = new Set<number>();
  let run: number[] = [];
  const endRun = () => {
    if (run.length >= 10) for (const index of run) inTables.add(index);
    run = [];
  };
  literals.forEach(({ start, end }, index) => {
    const previous = literals[index - 1];
    if (previous && !/^\s*,\s*$/.test(code.slice(previous.end, start))) endRun();
    if (/^.?$/su.test(literalText(code.slice(start, end)) ?? "xx")) run.push(index);
    else endRun();
  });
  endRun();
  return inTables;
}

/** The code of a line before the literal at `index`, with the literals before it on the line as `""`. */
function lineBefore(code: string, literals: ReadonlyArray<RubyLiteral>, index: number) {
  const start = literals[index]?.start ?? 0;
  const lineStart = code.lastIndexOf("\n", start - 1) + 1;
  let first = index;
  while (first > 0 && (literals[first - 1]?.end ?? 0) > lineStart) first--;
  let before = "";
  let at = lineStart;
  for (const literal of literals.slice(first, index)) {
    before += `${code.slice(at, Math.max(at, literal.start))}""`;
    at = literal.end;
  }
  return before + code.slice(at, start);
}

/**
 * The text of Ruby code: each string literal with Chinese, Japanese or Korean in it, by its index
 * among the code's literals, except those the code prints for its author or passes as a file or
 * font name, and character tables. Each comes with the game's own English for it from
 * `englishBranches`, when it has some.
 */
export function rubyText(code: string) {
  const literals = rubyLiterals(code);
  const tables = characterTables(code, literals);
  const branches = englishBranches(code, literals);
  return literals.flatMap(({ start, end }, literal) => {
    if (tables.has(literal)) return [];
    const text = literalText(code.slice(start, end));
    if (text === undefined || !sourceText.test(text.replace(interpolation, ""))) return [];
    if (isNameOrOutput(lineBefore(code, literals, literal))) return [];
    const other = literals[branches.get(literal) ?? -1];
    const english = other && literalText(code.slice(other.start, other.end));
    return [{ literal, text, ...(english !== undefined && { english }) }];
  });
}

interface ScriptFound {
  readonly location: Extract<Location, { readonly _tag: "RubyScriptText" }>;
  readonly text: string;
  readonly english?: string;
}

/** The text of an XP game's scripts. */
export const scriptsText = (scripts: ReadonlyArray<RubyScript>): ReadonlyArray<ScriptFound> =>
  scripts.flatMap(({ name, code }, script) =>
    rubyText(code).map(({ literal, ...found }) => ({
      location: { _tag: "RubyScriptText", script, name, literal } as const,
      ...found,
    })),
  );

/** A literal's new text, as long as the literal still is `source`. */
export interface LiteralText {
  readonly source: string;
  readonly text: string;
}

const wordEdge = /^[\p{L}\p{N}]$/u;

/**
 * The text of the literal at `index` with a space where the code joins it with `+` to a value
 * or a string, and a letter or digit meets one on both sides. Pieces such as those of
 * `"…が" + n.to_s + "%アップ"` are translated alone, without the spaces English puts around the
 * value. A join between two strings gets its space at the end of the first, unless only the
 * second is translated.
 */
function withJoinSpaces(
  code: string,
  literals: ReadonlyArray<RubyLiteral>,
  index: number,
  text: string,
  texts: ReadonlyMap<number, LiteralText>,
) {
  const literal = literals[index];
  if (!literal || !text) return text;
  const shown = (at: number) => {
    const other = literals[at];
    return other && (texts.get(at)?.text ?? literalText(code.slice(other.start, other.end)));
  };
  let spaced = text;
  const after = /^[ \t]*\+(?!=)\s*/.exec(code.slice(literal.end, literal.end + 200));
  if (after && wordEdge.test(text.at(-1) ?? "")) {
    const next =
      literals[index + 1]?.start === literal.end + after[0].length ? shown(index + 1) : "a";
    if (next !== undefined && wordEdge.test(next[0] ?? "")) spaced += " ";
  }
  const before = code.slice(Math.max(0, literal.start - 200), literal.start);
  if (/[\w)\]}"'!?][ \t]*\+\s*$/.test(before) && wordEdge.test(text[0] ?? "")) {
    const previous = literals[index - 1];
    const joined = previous && /^\s*\+\s*$/.test(code.slice(previous.end, literal.start));
    const last = joined && !texts.has(index - 1) ? shown(index - 1) : joined ? undefined : "a";
    if (last !== undefined && wordEdge.test(last.at(-1) ?? "")) spaced = ` ${spaced}`;
  }
  return spaced;
}

/**
 * `texts` with each literal's text also set on its English from `englishBranches`, so a game's
 * English mode, or a fix that turns it on for one method, shows the translation.
 */
function withEnglishBranches(
  code: string,
  literals: ReadonlyArray<RubyLiteral>,
  texts: ReadonlyMap<number, LiteralText>,
) {
  const all = new Map(texts);
  for (const [index, english] of englishBranches(code, literals)) {
    const replacement = texts.get(index);
    const literal = literals[english];
    const source = literal && literalText(code.slice(literal.start, literal.end));
    if (replacement && source !== undefined && !all.has(english))
      all.set(english, { source, text: replacement.text });
  }
  return all;
}

/** The code with each literal at an index of `texts` set to its text; none when one isn't its source anymore. */
export function withTexts(code: string, sourceTexts: ReadonlyMap<number, LiteralText>) {
  const literals = rubyLiterals(code);
  const texts = withEnglishBranches(code, literals, sourceTexts);
  let changed = "";
  let from = 0;
  for (const [index, literal] of literals.entries()) {
    const replacement = texts.get(index);
    if (!replacement) continue;
    const quoted = code.slice(literal.start, literal.end);
    const current = literalText(quoted);
    if (current === undefined || !holdsSource(current, replacement.source)) return undefined;
    const text = withJoinSpaces(code, literals, index, replacement.text, texts);
    changed += code.slice(from, literal.start) + rubyLiteral(text, quoted);
    from = literal.end;
  }
  return [...texts.keys()].every((index) => index < literals.length)
    ? changed + code.slice(from)
    : undefined;
}

const rpgtlScript = (name: string, code: string) => [
  0,
  new TextEncoder().encode(name),
  zlibSync(new TextEncoder().encode(code)),
];

const fixScripts = (fixes: ReadonlyArray<RubyScript>) =>
  fixes.map((fix) => rpgtlScript(`RPGTL fix ${fix.name}`, fix.code));

/**
 * `rows` with `added` before `Main`, which starts the game, or before the last script, which is
 * `Main` in a game that renamed it.
 */
function beforeMain(rows: Array<Array<unknown>>, added: Array<Array<unknown>>) {
  const main = rows.findLastIndex(
    ([, name]) =>
      (typeof name === "string" || name instanceof Uint8Array) &&
      nameOf(name).trim().toLowerCase() === "main",
  );
  rows.splice(main < 0 ? Math.max(rows.length - 1, 0) : main, 0, ...added);
  return rows;
}

/**
 * `Scripts.rxdata` with the literals of `texts`, by script and literal index, set to their text,
 * then the game's fixes and RPGTL's scripts that draw English into images and fit it into the
 * game's text boxes, before `Main`. Scripts without text keep their bytes. Fails when a literal
 * isn't its source anymore.
 */
export const applyScriptTexts = (
  file: string,
  bytes: Uint8Array,
  texts: ReadonlyMap<number, ReadonlyMap<number, LiteralText>>,
  fixes: ReadonlyArray<RubyScript>,
): Result.Result<Uint8Array, GameDataChanged | GameFileInvalid> =>
  Result.flatMap(scriptRows(file, bytes), (rows) => {
    for (const [script, literals] of texts) {
      const row = rows[script];
      const code = row && codeOf(row[2]);
      const changed = code === undefined ? undefined : withTexts(code, literals);
      if (!row || changed === undefined) return Result.fail(new GameDataChanged({ file }));
      row[2] = zlibSync(new TextEncoder().encode(changed));
    }
    return Result.succeed(
      dump(
        beforeMain(rows, [
          ...fixScripts(fixes),
          rpgtlScript("RPGTL image text", xpImageScript),
          rpgtlScript("RPGTL text fitting", textFittingScript),
        ]),
      ),
    );
  });

/** `Scripts.rxdata` with only the game's fixes added before `Main`. */
export const applyXpFixes = (file: string, bytes: Uint8Array, fixes: ReadonlyArray<RubyScript>) =>
  Result.map(scriptRows(file, bytes), (rows) => dump(beforeMain(rows, fixScripts(fixes))));
