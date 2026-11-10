const hangul = /\p{Script=Hangul}/u;

/**
 * Where `term` first appears in `text` from `from` on, or -1. Korean writes words apart with
 * particles after them (토키가), so a Hangul term right after another Hangul letter is the end of
 * a longer word, not the term.
 */
export function termIndex(text: string, term: string, from = 0): number {
  const wordStart = hangul.test(term.charAt(0));
  for (let at = text.indexOf(term, from); at >= 0; at = text.indexOf(term, at + 1))
    if (!wordStart || !hangul.test(text.charAt(at - 1))) return at;
  return -1;
}

export const hasTerm = (text: string, term: string) => termIndex(text, term) >= 0;
