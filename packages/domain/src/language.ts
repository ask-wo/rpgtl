import type { Entry, SourceLanguage } from "@rpgtl/contracts";

const hangul = /\p{Script=Hangul}/gu;
const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const han = /\p{Script=Han}/gu;
const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

/**
 * The language the game's text looks like. Korean games write a few words in Chinese characters
 * and Chinese fan games spell a few Japanese sounds in kana, so a script must make up a good share
 * of the text, not just appear in it.
 */
export function guessedLanguage(entries: ReadonlyArray<Pick<Entry, "source">>): SourceLanguage {
  let korean = 0;
  let japanese = 0;
  let all = 0;
  for (const { source } of entries) {
    const syllables = count(source, hangul);
    const sounds = count(source, kana);
    korean += syllables;
    japanese += sounds;
    all += syllables + sounds + count(source, han);
  }
  if (all > 0 && korean >= 0.3 * all) return "korean";
  if (all > 0 && japanese >= 0.15 * all) return "japanese";
  return "chinese";
}

/** The language the user chose for the game's text, or else the one it looks like. */
export const gameLanguage = (catalog: {
  readonly language?: SourceLanguage;
  readonly entries: ReadonlyArray<Pick<Entry, "source">>;
}): SourceLanguage => catalog.language ?? guessedLanguage(catalog.entries);

export const languageNames: Record<SourceLanguage, string> = {
  chinese: "Chinese",
  japanese: "Japanese",
  korean: "Korean",
};
