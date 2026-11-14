import {
  type GlossaryTerm,
  type RetrySampling,
  type Sampling,
  type SourceLanguage,
  TermKind,
} from "@rpgtl/contracts";
import * as Schema from "effect/Schema";
import { languageNames } from "./language.ts";
import { genderWords } from "./pronouns.ts";
import type { TermInput } from "./termKinds.ts";

/** An entry as a translation request sends it, numbered within its batch. */
export interface RequestEntry {
  readonly id: string;
  /** Set only when a request holds entries of more than one scene. */
  readonly scene?: number;
  readonly speaker?: string;
  readonly text: string;
  /**
   * The image the text is drawn in, below `img/` or an XP game's `Graphics/`, such as
   * `titles1/Command_0`.
   */
  readonly image?: string;
  /** Only set where the natural English would not fit its image. */
  readonly limit?: number;
}

/** Text before or after a batch, sent for reference only. */
export interface ContextLine {
  readonly scene?: number;
  readonly speaker?: string;
  readonly source: string;
  readonly translation?: string;
}

/** A glossary term as a request sends it; sound hints carry a note. */
export interface PromptTerm {
  readonly source: string;
  readonly translation: string;
  readonly note?: string;
}

const translationInstructions = `Translate each entry's text from an RPG Maker game into natural English.
Context is earlier text for reference only. Speaker is who says the line.
Glossary gives fixed translations for names and terms; use them whenever the term appears. A term's note says what it means and how to write it.
Pronouns, when given, says which pronouns to use for a character.
Answer with one JSON object mapping every entry id to its translation and nothing else.
Keep every placeholder like {1} exactly once and add none. Keep the line breaks of each text.
⏸ is a short pause in the dialogue and shows nothing: put each one where the same pause falls in your English, or leave it out. It is not punctuation, so keep the commas and periods your English needs.
Translate adult and violent fiction faithfully without softening, notes or explanations.
Image, when given, is the game image the text is drawn in, such as a title menu's buttons in titles1/Command_0 and titles1/Command_1: translate them as the labels players know from other games.
Limit, when given, is how many characters fit where the text is drawn in an image: prefer a short word, a common game abbreviation or a shorter synonym, but never drop meaning to fit.`;
const namesInstructions: Record<SourceLanguage, string> = {
  chinese:
    "Write Chinese person names in Hanyu Pinyin with the family name separate and capitalised (林若溪 → Lin Ruoxi), and names that sound Western or Japanese in their usual English spelling (伊莎贝拉 → Isabella).",
  japanese:
    "Write Japanese person names in Hepburn romanisation of their Japanese reading, without macrons and in the order the text gives them (佐藤花子 → Sato Hanako), and names that sound Western in their usual English spelling (エリザベス → Elizabeth).",
  korean:
    "Write Korean person names with the family name first in its usual spelling and the given name in Revised Romanization as one word (김민지 → Kim Minji, 이서준 → Lee Seojun), and names that sound Western or Japanese in their usual English spelling (엘리자베스 → Elizabeth, 하루토 → Haruto).",
};
const scenesInstruction =
  "Entries and context lines with a scene number come from separate scenes of the game: use only a scene's own context for its entries, and treat different scenes as unrelated.";
const followingInstruction =
  "Following is the text right after the entries, for reference only; don't translate it.";

/**
 * The system prompt of a request in the default format. Each part beyond the base is added only
 * when the request needs it, or always where a translator caches the system prompt.
 */
export function translationSystemPrompt(parts: {
  readonly language: SourceLanguage;
  readonly names: boolean;
  readonly scenes: boolean;
  readonly following: boolean;
}) {
  return [
    translationInstructions,
    ...(parts.names ? [namesInstructions[parts.language]] : []),
    ...(parts.scenes ? [scenesInstruction] : []),
    ...(parts.following ? [followingInstruction] : []),
  ].join("\n");
}

/** What a request in the default format asks about, as the JSON of its user message. */
export interface TranslationInput {
  readonly glossary: ReadonlyArray<PromptTerm>;
  readonly pronouns: ReadonlyArray<string>;
  readonly context: ReadonlyArray<ContextLine>;
  readonly entries: ReadonlyArray<RequestEntry>;
  readonly following: ReadonlyArray<ContextLine>;
}

export const translationUserMessage = (input: TranslationInput) =>
  JSON.stringify({
    ...(input.glossary.length && {
      glossary: input.glossary.map(({ source, translation, note }) => ({
        source,
        translation,
        ...(note && { note }),
      })),
    }),
    ...(input.pronouns.length && { pronouns: input.pronouns }),
    context: input.context,
    entries: input.entries,
    ...(input.following.length && { following: input.following }),
  });

/** An answer that was too long for its image, as the follow-up question names it. */
export interface LongAnswer {
  readonly id: string;
  readonly answer: string;
  readonly length: number;
  readonly limit: number;
}

/** The follow-up turn asking for shorter answers where the first ones didn't fit their images. */
export const shorterAnswersQuestion = (long: ReadonlyArray<LongAnswer>) =>
  [
    ...long.map(
      ({ id, answer, length, limit }) =>
        `Entry ${id}: ${JSON.stringify(answer)} has ${length} characters, but its image has room for ${limit}.`,
    ),
    "Answer again for these entries with a shorter English word or phrase with the same meaning that fits. For a menu or button, use the label other games use for the same thing, such as New Game for starting one, rather than cutting words off.",
  ].join("\n");

/** A batch's answer: one translation for each entry id. */
export const TranslationAnswer = (keys: ReadonlyArray<string>) =>
  Schema.Struct(Object.fromEntries(keys.map((key) => [key, Schema.String])));

// Qwen's recommended settings for Qwen3.6-35B-A3B without thinking:
// https://huggingface.co/Qwen/Qwen3.6-35B-A3B
const qwenSampling = {
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  min_p: 0,
  presence_penalty: 1.5,
  repeat_penalty: 1,
};
// Qwen's recommended settings for Qwen3.6-35B-A3B with thinking on general tasks, from the same card.
const qwenThinkingSampling = { ...qwenSampling, temperature: 1, top_p: 0.95 };

/**
 * How a local model samples a retry. Qwen3.6 stores its settings for thinking, which fit only
 * while it thinks, so it keeps Qwen's settings above; other models get their own.
 */
export const retrySampling = (model: string, sampling: Sampling): RetrySampling =>
  sampling === "qwen" || /qwen3\.6/i.test(model) ? "qwen" : "model";

/** The sampling options a local model gets, as Ollama and llama-server name them. */
export const samplingOptions = (
  sampling: Sampling,
  think: boolean,
): { readonly temperature: number } & Readonly<Record<string, number>> =>
  sampling === "temperature-0" ? { temperature: 0 } : think ? qwenThinkingSampling : qwenSampling;

/**
 * Caps an answer at well above what a translation needs: across 290 batches of a Chinese game, Qwen
 * used at most 3.2 tokens per source character. A model that repeats itself stops here.
 */
export const answerTokenLimit = (entries: ReadonlyArray<Pick<RequestEntry, "text">>) =>
  64 + entries.reduce((tokens, entry) => tokens + 32 + 4 * entry.text.length, 0);

const kindExamples: Record<
  SourceLanguage,
  { character: string; word: string; shared: string; label: string }
> = {
  chinese: {
    character: "魔法少女美咲, 面具男人, 兽人酋长",
    word: "武器, 盗贼, 旅馆",
    shared: "石像鬼, 冰霜巨人, Slime",
    label: "客人, NPC, 村民们, ？？？",
  },
  japanese: {
    character: "魔法少女ミサキ, 仮面の男, オークの族長",
    word: "武器, 盗賊, 宿屋",
    shared: "ガーゴイル, フロストジャイアント, Slime",
    label: "客, NPC, 村人たち, ？？？",
  },
  korean: {
    character: "마법소녀 미나, 가면 쓴 남자, 오크 족장",
    word: "무기, 도적, 여관",
    shared: "가고일, 서리 거인, Slime",
    label: "손님, NPC, 마을 사람들, ？？？",
  },
};

const kindPrompt = (language: SourceLanguage) => {
  const examples = kindExamples[language];
  return `Sort the glossary terms of a ${languageNames[language]} RPG Maker game by kind. For each numbered term answer one kind:
- character: one particular person, creature or being in the story, also one known by a title, role or description (${examples.character}), and a unique monster such as a boss.
- name: any other proper name: a place, ship, organisation, family, faction or event, or an item, skill or spell with an invented name.
- word: an ordinary word or phrase: common nouns (${examples.word}), stats, equipment types, kinds of monsters or enemies that many share (${examples.shared}), and labels that any member of a group can have (${examples.label}).
Each term comes with where the game uses it, such as an actor's name, a speaker's name or an item's name, and up to three lines that mention it. A speaker is a word when the label is shared by many people.
Answer with one JSON object mapping every term number to its kind.`;
};

/** A question to a model whose answer is one JSON object that `answer` decodes. */
export interface JsonQuestion<S extends Schema.Top> {
  readonly system: string;
  readonly user: string;
  readonly answer: S;
}

/** Asks for the kind of each term, numbered from 1 in the order given. */
export function kindQuestion(
  inputs: ReadonlyArray<TermInput>,
  language: SourceLanguage,
): JsonQuestion<Schema.Struct<Record<string, typeof TermKind>>> {
  const keys = inputs.map((_, index) => String(index + 1));
  return {
    system: kindPrompt(language),
    user: JSON.stringify(
      Object.fromEntries(
        inputs.map((input, index) => [
          String(index + 1),
          {
            term: input.term,
            ...(input.usedAs.length && { usedAs: input.usedAs }),
            ...(input.lines.length && { lines: input.lines }),
          },
        ]),
      ),
    ),
    answer: Schema.Struct(Object.fromEntries(keys.map((key) => [key, TermKind]))),
  };
}

const genderHints: Record<SourceLanguage, string> = {
  chinese:
    "她 means she and 他 means he, but 他 is also used when the gender is unknown, and a 他 or 她 can be about someone else in the line. The name itself can say it too, such as 少女 in it or characters used for female names like 娜 or 妮.",
  japanese:
    "彼女 means she and 彼 means he, but either can be about someone else in the line, and 他 means other. A title after the name can say it, such as 姉 or 嬢 for a woman and 兄 or くん mostly for a man, and so can how the character says I: あたし for a woman, 俺 mostly for a man. The name itself can say it too, such as 少女 in it.",
  korean:
    "그녀 means she and 그 before a particle (그는, 그가, 그의) means he, but either can be about someone else in the line. A title after the name can say it: 누나, 언니 and 아줌마 for a woman, 형, 오빠 and 아저씨 for a man. So can what the character calls others: a woman calls an older man 오빠 and an older woman 언니, and a man calls an older woman 누나 and an older man 형. The name itself can say it too, such as 소녀 in it.",
};

const pronounPrompt = (language: SourceLanguage) =>
  `Decide the pronoun of a character in an RPG Maker game from the ${languageNames[language]} lines about them. Lines starting with the character's name and a colon are what the character says. ${genderHints[language]} First quote, in "evidence", the shortest text from the lines or the name that shows the character's gender, copied exactly; leave it empty when nothing does, and don't guess from how the character talks. Then answer she or he only if the evidence shows it; otherwise answer unknown. Answer with one JSON object with the keys "evidence" and "pronoun".`;

/** What the pronoun question asks a model to answer. */
export const PronounAnswer = Schema.Struct({
  /** Models without a schema to follow may leave it out; the pronoun is then unknown. */
  evidence: Schema.optionalKey(Schema.String),
  pronoun: Schema.Literals(["she", "he", "unknown"]),
});

/** Asks for a character's pronoun, with the text that shows it. */
export const pronounQuestion = (
  term: Pick<GlossaryTerm, "source">,
  lines: ReadonlyArray<string>,
  language: SourceLanguage,
): JsonQuestion<typeof PronounAnswer> => ({
  system: pronounPrompt(language),
  user: JSON.stringify({ character: term.source, lines }),
  answer: PronounAnswer,
});

// What a quote from the lines needs to show a gender; any part of the name may show it.
const genderedText: Record<SourceLanguage, RegExp> = {
  chinese: /[她他女男姐妹哥弟叔姨娘爷婆母父]|先生|小姐|公主|王子|少年|少爷|老子/,
  japanese: /[彼女男姉妹兄弟母父嬢娘姫]|王子|少年|くん/,
  korean:
    /그녀|그(?:는|가|의|를|에게)|여자|남자|소녀|소년|누나|언니|오빠|형|아줌마|아저씨|할머니|할아버지|어머니|아버지|엄마|아빠|아가씨|공주|왕자|딸|아들/,
};

/**
 * The pronoun a model answered, or unknown when its evidence doesn't show it: a quote from the
 * name, or from the lines with a gendered word in it.
 */
export function shownPronoun(
  term: Pick<GlossaryTerm, "source">,
  lines: ReadonlyArray<string>,
  answer: typeof PronounAnswer.Type,
  language: SourceLanguage,
) {
  const words = genderWords[language];
  if (answer.pronoun === "unknown") return answer.pronoun;
  const evidence = answer.evidence?.trim() ?? "";
  // In the character's own lines, a gendered word is mostly about whom they talk to.
  const own = `${term.source}: `;
  const shown =
    !!evidence &&
    (term.source.includes(evidence) ||
      lines.some((line) =>
        line.startsWith(own)
          ? line.includes(evidence) &&
            [...words.femaleSays, ...words.maleSays].some((word) => evidence.includes(word))
          : line.includes(evidence) && genderedText[language].test(evidence),
      ));
  return shown ? answer.pronoun : "unknown";
}
