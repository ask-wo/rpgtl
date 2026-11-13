/** A `"…"` or `'…'` string literal in Ruby code, outside other strings. */
export interface RubyLiteral {
  /** Where its opening quote is. */
  readonly start: number;
  /** Where the code after its closing quote starts. */
  readonly end: number;
}

// Words after which an expression starts, so `/` starts a regex and `?` a character.
const keywords = new Set([
  "and",
  "case",
  "do",
  "else",
  "elsif",
  "if",
  "in",
  "not",
  "or",
  "return",
  "then",
  "unless",
  "until",
  "when",
  "while",
  "yield",
]);

const openers: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

/**
 * The string literals of a Ruby script, in order; none when the script has a heredoc or ends
 * inside a literal, which this reader doesn't follow. Comments, regexes, `%` literals, symbols
 * and the code inside `#{}` are skipped.
 */
export function rubyLiterals(code: string): ReadonlyArray<RubyLiteral> {
  const found: RubyLiteral[] = [];
  let at = 0;
  let unsupported = false;
  // Whether the last token ends a value, after which `/`, `%` and `?` are operators.
  let afterValue = false;
  // Whether a space came after a word that may be a method, as in `split /,/`.
  let spacedWord = false;

  const atLineStart = () => at === 0 || code[at - 1] === "\n";

  /** Skips a quoted body that ends at `close`, from just after its opening; `#{}` code too when `interpolates`. */
  const skipQuoted = (close: string, interpolates: boolean, open?: string) => {
    let depth = 0;
    while (at < code.length) {
      const char = code[at];
      if (char === "\\") at += 2;
      else if (interpolates && char === "#" && code[at + 1] === "{") {
        at += 2;
        skipCode("}");
        at++;
      } else if (open !== undefined && char === open) {
        depth++;
        at++;
      } else if (char === close) {
        at++;
        if (depth-- === 0) return;
      } else at++;
    }
    unsupported = true;
  };

  /** Reads code until `until` at depth 0, or to the end; the literals at the top level are found. */
  const skipCode = (until?: string) => {
    let depth = 0;
    const top = until === undefined;
    while (at < code.length) {
      const char = code[at] ?? "";
      const next = code[at + 1] ?? "";
      if (until !== undefined && char === until && depth === 0) return;
      if (char === "\n" || char === " " || char === "\t" || char === "\r") {
        if (char === "\n") spacedWord = false;
        else if (afterValue) spacedWord = spacedWord || isWordEnd(at);
        at++;
        continue;
      }
      if (atLineStart() && code.startsWith("__END__", at) && /^\r?(\n|$)/.test(code.slice(at + 7)))
        return;
      if (atLineStart() && /^=begin\s/.test(code.slice(at, at + 7))) {
        const end = code.indexOf("\n=end", at);
        at = end < 0 ? code.length : end + 5;
        while (at < code.length && code[at] !== "\n") at++;
        continue;
      }
      if (char === "#") {
        while (at < code.length && code[at] !== "\n") at++;
        continue;
      }
      const wasSpaced = spacedWord;
      spacedWord = false;
      if (char === '"' || char === "'") {
        const start = at;
        at++;
        skipQuoted(char, char === '"');
        if (top) found.push({ start, end: at });
        afterValue = true;
      } else if (char === "`") {
        at++;
        skipQuoted("`", true);
        afterValue = true;
      } else if (/[A-Za-z_\u0080-￿]/.test(char)) {
        const start = at;
        while (at < code.length && /[\w\u0080-￿]/.test(code[at] ?? "")) at++;
        if ((code[at] === "?" || code[at] === "!") && code[at + 1] !== "=") at++;
        afterValue = code[start - 1] === "." || !keywords.has(code.slice(start, at));
      } else if (/\d/.test(char)) {
        while (at < code.length && /[\w.]/.test(code[at] ?? "")) {
          if (code[at] === "." && !/\d/.test(code[at + 1] ?? "")) break;
          at++;
        }
        afterValue = true;
      } else if (char === "@") {
        at++;
        while (at < code.length && /[\w@]/.test(code[at] ?? "")) at++;
        afterValue = true;
      } else if (char === "$") {
        at += /[\w]/.test(next) ? 1 : 2;
        while (at < code.length && /\w/.test(code[at] ?? "")) at++;
        afterValue = true;
      } else if (char === ":" && next === ":") {
        at += 2;
        afterValue = false;
      } else if (char === ":" && !afterValue && (next === '"' || next === "'")) {
        at += 2;
        skipQuoted(next, next === '"');
        afterValue = true;
      } else if (char === ":" && /[A-Za-z_]/.test(next) && !afterValue) {
        at++;
        while (at < code.length && /\w/.test(code[at] ?? "")) at++;
        if (/[?!=]/.test(code[at] ?? "") && code[at + 1] !== "=" && code[at + 1] !== ">") at++;
        afterValue = true;
      } else if (char === "/" && (!afterValue || (wasSpaced && !/[\s=]/.test(next)))) {
        at++;
        skipQuoted("/", true);
        while (/[a-z]/.test(code[at] ?? "")) at++;
        afterValue = true;
      } else if (
        char === "%" &&
        (!afterValue || (wasSpaced && !/[\s=]/.test(next))) &&
        /^[qQwWiIrsx]?[^\w\s]/.test(code.slice(at + 1, at + 3))
      ) {
        at++;
        const kind = /[qQwWiIrsx]/.test(code[at] ?? "") ? (code[at++] ?? "") : "Q";
        const open = code[at++] ?? "";
        const close = openers[open] ?? open;
        skipQuoted(close, /[QWIrx]/.test(kind), close === open ? undefined : open);
        if (kind === "r") while (/[a-z]/.test(code[at] ?? "")) at++;
        afterValue = true;
      } else if (char === "?" && !afterValue && /\S/.test(next)) {
        at += next === "\\" ? 3 : 2;
        afterValue = true;
      } else if ((!afterValue || wasSpaced) && /^<<[-~]?["'`A-Z_]/.test(code.slice(at, at + 4))) {
        unsupported = true;
        at = code.length;
      } else if (char === "(" || char === "[" || char === "{") {
        if (char === "{" && until === "}") depth++;
        at++;
        afterValue = false;
      } else if (char === ")" || char === "]" || char === "}") {
        if (char === "}" && until === "}") depth--;
        at++;
        afterValue = true;
      } else {
        at++;
        afterValue = false;
      }
    }
  };

  /** Whether the code before `space` ends a word that may be a method taking an argument. */
  const isWordEnd = (space: number) =>
    /[A-Za-z_]\w*[?!]?$/.test(code.slice(Math.max(0, space - 40), space));

  skipCode();
  return unsupported ? [] : found;
}
