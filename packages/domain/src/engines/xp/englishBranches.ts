import type { Entry } from "@rpgtl/contracts";
import { shownText } from "../../controlCodes.ts";
import { sourceText } from "../mvmz/extract.ts";
import type { RubyLiteral } from "./rubyLiterals.ts";

const interpolation = /#\{[^{}]*\}/g;
const lineStart = /^[ \t]*/;
const switchRead = /\$game_switches\[/;

const hasSource = (text: string) => sourceText.test(text.replace(interpolation, ""));
const indent = (text: string) => lineStart.exec(text)?.[0].length ?? 0;
const codesOf = (literal: string) => (literal.match(interpolation) ?? []).toSorted().join();

/**
 * The code between `from` and `to` with each literal as `""`, each number as `0` and no comments or
 * spaces, so two branches compare equal when they differ only in their strings and numbers.
 */
function shape(code: string, literals: ReadonlyArray<RubyLiteral>, from: number, to: number) {
  let masked = "";
  let at = from;
  for (const literal of literals) {
    if (literal.start < from || literal.end > to) continue;
    masked += `${code.slice(at, literal.start)}""`;
    at = literal.end;
  }
  masked += code.slice(at, to);
  return masked
    .replace(/#[^\n]*/g, "")
    .replace(/\b\d+(?:\.\d+)?\b/g, "0")
    .replace(/\s+/g, " ")
    .trim();
}

/** The `if` or `unless` blocks on a switch with one `else`, as the ranges of their two branches. */
function ifElseBlocks(code: string) {
  const lines: Array<{ start: number; text: string }> = [];
  let start = 0;
  for (const text of code.split("\n")) {
    lines.push({ start, text });
    start += text.length + 1;
  }
  const blocks: Array<readonly [readonly [number, number], readonly [number, number]]> = [];
  lines.forEach(({ text }, at) => {
    if (!/^\s*(?:if|unless)\b/.test(text) || !switchRead.test(text)) return;
    const depth = indent(text);
    let otherwise: number | undefined;
    for (let next = at + 1; next < lines.length; next++) {
      const line = lines[next]?.text ?? "";
      if (!line.trim() || line.trim().startsWith("#") || indent(line) > depth) continue;
      if (indent(line) < depth) return;
      if (otherwise === undefined && /^\s*else\s*(?:#.*)?$/.test(line)) otherwise = next;
      else if (otherwise !== undefined && /^\s*end\b/.test(line)) {
        const position = (index: number) => lines[index]?.start ?? code.length;
        blocks.push([
          [position(at + 1), position(otherwise)],
          [position(otherwise + 1), position(next)],
        ]);
        return;
      } else return;
    }
  });
  return blocks;
}

/**
 * For each literal with Chinese, Japanese or Korean in it, by index, the literal at the same place
 * on the other side of an `if`/`else` or `? :` whose two sides differ only in their strings and
 * numbers, when that one holds none and the same `#{}` code, and the condition reads a switch:
 * games with an English mode pick the side by one, and other conditions pick between texts the game
 * shows. Blocks are found by their indentation, as `if`, `else` and `end` line up in the
 * code games write.
 */
export function englishBranches(code: string, literals: ReadonlyArray<RubyLiteral>) {
  const quoted = literals.map(({ start, end }) => code.slice(start, end));
  const pairs = new Map<number, number>();
  const pair = (one: number, other: number) => {
    const [source, english] = [quoted[one] ?? "", quoted[other] ?? ""];
    if (codesOf(source) !== codesOf(english)) return;
    if (hasSource(source) && !hasSource(english)) pairs.set(one, other);
    else if (hasSource(english) && !hasSource(source)) pairs.set(other, one);
  };
  const inside = (from: number, to: number) =>
    literals.flatMap((literal, index) =>
      literal.start >= from && literal.end <= to ? [index] : [],
    );
  for (const [[thenFrom, thenTo], [elseFrom, elseTo]] of ifElseBlocks(code)) {
    const first = inside(thenFrom, thenTo);
    const second = inside(elseFrom, elseTo);
    if (first.length !== second.length) continue;
    if (shape(code, literals, thenFrom, thenTo) !== shape(code, literals, elseFrom, elseTo))
      continue;
    first.forEach((index, at) => pair(index, second[at] ?? index));
  }
  literals.forEach((literal, index) => {
    const next = literals[index + 1];
    if (!next || !/^\s*:\s*$/.test(code.slice(literal.end, next.start))) return;
    const line = code.slice(code.lastIndexOf("\n", literal.start) + 1, literal.start);
    if (/\$game_switches\[[^?]*\?\s*$/.test(line)) pair(index, index + 1);
  });
  return pairs;
}

const wide = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿！-｠]/u;

/**
 * How many characters a translation has room for where the game draws it, from the game's own
 * English for the text: the wider of that English and the source, since both fit there, a
 * full-width character counting as 1.8 letters, times 5/3, since text fitting shrinks text to 3/5
 * of its size. The English alone would be too strict: authors abbreviate far more than needed
 * ("Yes" for a choice to cut or replace). None when the English has no letters, as a `"????"` the
 * author left to fill in.
 */
export function gameEnglishLimit(entry: Pick<Entry, "source" | "gameEnglish">) {
  const english =
    entry.gameEnglish === undefined ? "" : shownText(entry.gameEnglish.replace(interpolation, "0"));
  if (!/[A-Za-z]/.test(english)) return undefined;
  let source = 0;
  for (const char of shownText(entry.source.replace(interpolation, "0")))
    source += wide.test(char) ? 1.8 : 1;
  return Math.ceil((5 / 3) * Math.max(source, english.length));
}
