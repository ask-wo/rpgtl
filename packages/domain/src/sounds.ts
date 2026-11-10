// Japanese phrases that Chinese fan games spell with Chinese characters for their sound, and
// Chinese interjections whose meaning the sound alone doesn't give away. Models translate the
// characters' sounds literally ("呀...嘞...呀...嘞" became "Yay... yay..." and "Ah... la..."), so
// a batch that contains one gets its meaning as a glossary hint. Japanese phrases stay in
// romaji, like the honorifics ("Onii-chan", "Senpai") the model already keeps.

interface SoundHint {
  /** Characters in order; a bracket holds the spellings one syllable can have. */
  spelling: string;
  translation: string;
  /** What the phrase means and how to write it, in plain English. */
  note: string;
  /** Matches only with nothing between the characters, so that "哟！西瓜" isn't "哟西". */
  joined?: boolean;
  /** Matches only with a pause (an ellipsis or tilde) between the characters, so that the plain
   * Chinese "啊啦，" isn't "ara ara". */
  paused?: boolean;
  /** A phrase games split into syllables, which models then wrote twice. */
  split?: boolean;
}

// Games split a drawn-out phrase into syllables with pauses (呀...嘞...呀...嘞...), and models
// then wrote it twice ("Ara ara... ara ara..."), so a phrase games split gets an example of it
// written once, the way English writes it.
const japanese = (romaji: string, meaning: string, split?: string) =>
  `Japanese "${romaji}" spelled in Chinese characters for its sound: ${meaning}. Write it in romaji.` +
  (split
    ? ` The spelling is the whole phrase once, even when pauses split its syllables: write it once, without pauses inside it (${split}).`
    : "");
const word = (spelling: string, translation: string, meaning: string): SoundHint => ({
  spelling,
  translation,
  note: japanese(translation.toLowerCase(), meaning),
  joined: true,
});

const yareYare = "a weary sigh, like 'good grief' or 'here we go again'";
const araAra = "an amused, teasing 'oh my, oh my', typically from an older woman";

const soundHints: SoundHint[] = [
  {
    spelling: "[呀压鸭牙雅][嘞咧列][呀压鸭牙雅][嘞咧列]",
    translation: "Yare yare",
    note: japanese("yare yare", yareYare, '呀...嘞...呀...嘞... is "Yare yare..."'),
    split: true,
  },
  // Games also shorten it to one 呀嘞, which models wrote "Yay... yay..."; 列 stays out because
  // "呀，列车" is ordinary Chinese.
  {
    spelling: "[呀压鸭牙雅][嘞咧]",
    translation: "Yare yare",
    note: japanese("yare yare", yareYare, '呀...嘞... is "Yare yare..." too'),
    split: true,
  },
  {
    spelling: "[阿啊][拉啦][阿啊][拉啦]",
    translation: "Ara ara",
    note: japanese("ara ara", araAra, '啊...啦...啊...啦... is "Ara ara..."'),
    split: true,
  },
  // Games shorten it to 啊...啦...啦... or 啊...啦..., which models wrote "Ah... la... la...".
  {
    spelling: "[阿啊][拉啦][拉啦]",
    translation: "Ara ara",
    note: japanese("ara ara", araAra, '啊...啦...啦... is "Ara ara..." too'),
    paused: true,
    split: true,
  },
  {
    spelling: "[阿啊][拉啦]",
    translation: "Ara ara",
    note: japanese("ara ara", araAra, '啊...啦... is "Ara ara..." too'),
    paused: true,
    split: true,
  },
  {
    spelling: "[咿伊]呀",
    translation: "Iya",
    note: `${japanese("iya", "a squeal of 'no!' or 'eek!'")} Stretch it rather than repeat it: 咿呀呀呀 is "Iyaaa!"`,
  },
  word("[斯死]国一", "Sugoi", "'amazing!'"),
  word("卡哇伊", "Kawaii", "'cute!'"),
  word("[欧哦]尼酱", "Onii-chan", "'big brother'"),
  word("[欧哦][内捏]酱", "Onee-chan", "'big sister'"),
  word("八嘎", "Baka", "'idiot!'"),
  word("[哟呦]西", "Yoshi", "'all right!'"),
  word("[达打]咩", "Dame", "'no, don't!'"),
  word("[雅亚][蠛灭美][蝶跌爹]", "Yamete", "'stop!'"),
  word("阿里[嘎噶][多都]", "Arigatou", "'thank you'"),
  word("[欧哦]哈[哟呦]", "Ohayou", "'good morning'"),
  {
    spelling: "呜呜",
    translation: "Waaah",
    note: "Crying or whimpering, not a word. Write a sob or whimper that fits the scene (Waaah, Uuu, Mmph when the mouth is covered).",
  },
  {
    spelling: "哈啊",
    translation: "Haah",
    note: "A heavy breath: panting, a sigh or a moan, not laughter.",
    joined: true,
  },
  {
    spelling: "[诶欸]嘿",
    translation: "Ehehe",
    note: "An embarrassed or playful giggle (Japanese 'ehehe', 'tehe').",
  },
  {
    spelling: "嘿嘿",
    translation: "Hehe",
    note: "A sly or embarrassed giggle; repeat it as often as the source does.",
  },
  { spelling: "嘻嘻", translation: "Teehee", note: "A playful, mischievous giggle." },
  {
    spelling: "呵呵",
    translation: "Heh heh",
    note: "A soft chuckle, often smug, polite or knowing; repeat it as often as the source does.",
  },
  {
    spelling: "啧",
    translation: "Tch",
    note: "A click of the tongue in annoyance or disdain; 啧啧 can also be impressed tutting.",
  },
  {
    spelling: "咕噜",
    translation: "Gulp",
    note: "A swallowing or gurgling sound, or a stomach growling.",
  },
];

// Games split syllables with ellipses, tildes, exclamation marks, line breaks or control codes
// (sent as placeholders like {1}), so anything that is no letter or digit may stand between them.
const gap = String.raw`(?:[^\p{L}\p{N}]|\{\d+\})*?`;
const pause = String.raw`${gap}[.…~～]${gap}`;
const hints = soundHints.map((hint) => ({
  ...hint,
  pattern: new RegExp(
    (hint.spelling.match(/\[[^\]]+\]|./gu) ?? []).join(
      hint.joined ? "" : hint.paused ? pause : gap,
    ),
    "u",
  ),
}));

/**
 * The hints whose phrases appear in the texts, each with its spelling in the first text found. A
 * shorter spelling of a phrase already found adds nothing.
 */
export function matchingSounds(texts: string[]) {
  const found: { source: string; translation: string; note: string }[] = [];
  for (const hint of hints) {
    if (found.some((sound) => sound.translation === hint.translation)) continue;
    const match = texts.map((text) => hint.pattern.exec(text)).find(Boolean);
    if (match) found.push({ source: match[0], translation: hint.translation, note: hint.note });
  }
  return found;
}

// How often a split phrase appears in a text, counted by its longest spelling found there.
function timesSpelled(text: string, translation: string) {
  for (const hint of hints) {
    if (hint.translation !== translation) continue;
    const count = text.match(new RegExp(hint.pattern, "gu"))?.length ?? 0;
    if (count) return count;
  }
  return 0;
}

/**
 * The translation with a split phrase written once where the source spells it once: models
 * wrote 呀...嘞...呀...嘞... as "Yare yare... Yare yare..." even with the hint.
 */
export function onceEach(source: string, translation: string) {
  for (const phrase of new Set(
    soundHints.filter((hint) => hint.split).map((hint) => hint.translation),
  )) {
    if (timesSpelled(source, phrase) !== 1) continue;
    const name = RegExp.escape(phrase);
    translation = translation.replace(
      new RegExp(`(${name})(?:[^\\p{L}\\p{N}]+${name})+`, "giu"),
      "$1",
    );
  }
  return translation;
}
