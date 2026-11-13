import type {
  AnswerContext,
  Catalog,
  Entry,
  GlossaryTerm,
  PronounValue,
  RejectReason,
  SourceLanguage,
  TermKind,
} from "@rpgtl/contracts";
import type * as Types from "effect/Types";
import { answerSuggestion } from "./answers.ts";
import { sourceScript } from "./checks.ts";
import { speakerTagName, speakerTagPattern } from "./controlCodes.ts";
import { entryTranslation, termTranslation, termKind, withGuess } from "./guesses.ts";
import { keepsTags, withoutTags } from "./engines/xp/databaseTags.ts";
import { gameLanguage } from "./language.ts";
import { isImageText, isMessage, type Placed } from "./location.ts";
import { isActorName, isSpeakerNameEntry } from "./nameEntries.ts";
import { type NamedTerm, nameTerm } from "./nameTerm.ts";
import { collectClues, linesAbout, pronounFromClues } from "./pronouns.ts";
import { type RequestText, requestText, withoutCodes } from "./requestText.ts";
import { showTextSpeakers, translationReuse } from "./reuse.ts";
import { type TermInput, termInputs } from "./termKinds.ts";

const hasWords = (source: string) => withoutCodes(source).trim() !== "";

/** An entry a run fills in; it replaces the nested values whole, so only the top level changes. */
export type DraftEntry = Types.Mutable<Entry>;
/** An entry a run asks about: one of the draft's, or a speaker's name that lives only for the run. */
export type RunEntry = Types.Mutable<Omit<Entry, "location">> & Placed;
export type DraftTerm = Types.Mutable<GlossaryTerm>;

/** An entry with its source as a request sends it. */
export interface Prepared extends RequestText {
  readonly entry: RunEntry;
}

const han = /\p{Script=Han}/u;

/** A name entry whose English is the name itself, so short forms of it follow its spelling. */
const isOriginName = (entry: Pick<Entry, "id"> & Placed) =>
  isActorName(entry) || isSpeakerNameEntry(entry) || entry.id.startsWith("speaker:");

/** How an accepted answer is kept, beyond its translation. */
export interface Accepted {
  readonly flag?: string | undefined;
  /** The first answer, when the translation is a shorter second one for its image. */
  readonly long?: string | undefined;
  /** Adds the entry's source and English to the glossary, as the glossary pass does. */
  readonly seedGlossary?: boolean;
}

/**
 * A run's copy of a catalog, which it fills in as answers arrive. Requests running at once share
 * it: each method changes it in one synchronous step, so no change interleaves with another.
 */
export class CatalogDraft {
  /** The language of the game's text, which the prompts are written for. */
  readonly language: SourceLanguage;
  readonly #catalog: Catalog;
  readonly #entries: Array<DraftEntry>;
  readonly #glossary: Array<DraftTerm>;
  readonly #terms: Map<string, DraftTerm>;
  readonly #limits: ReadonlyMap<string, number>;
  readonly #failed = new Set<string>();
  readonly #reuse: ReturnType<typeof translationReuse<RunEntry>>;
  readonly #showTextSpeaker: (entry: RunEntry) => string | undefined;
  readonly #run: string | undefined;

  /**
   * `limits` is how many characters each image entry has room for, by entry id. `run`, when the
   * run started, goes on every guess the draft makes.
   */
  constructor(catalog: Catalog, limits: ReadonlyMap<string, number>, run?: string) {
    this.#catalog = catalog;
    this.#run = run;
    this.language = gameLanguage(catalog);
    this.#entries = catalog.entries.map((entry) => ({ ...entry }));
    this.#glossary = catalog.glossary.map((term) => ({ ...term }));
    this.#terms = new Map(this.#glossary.map((term) => [term.source, term]));
    this.#limits = limits;
    this.#showTextSpeaker = showTextSpeakers<RunEntry>(this.#entries);
    this.#reuse = translationReuse<RunEntry>(this.translatable, run);
    this.#reuse.fillAll();
  }

  get entries(): ReadonlyArray<DraftEntry> {
    return this.#entries;
  }

  /** The glossary; sorting terms and finding pronouns change its terms in place. */
  get glossary(): ReadonlyArray<DraftTerm> {
    return this.#glossary;
  }

  /** The entries a run translates: all but images the game shows unchanged. */
  get translatable(): ReadonlyArray<DraftEntry> {
    const originals = this.#catalog.unchangedImages ?? [];
    return this.#entries.filter(
      (entry) =>
        !entry.keepOriginal && !(isImageText(entry) && originals.includes(entry.location.image)),
    );
  }

  /** A copy of the draft as a catalog. */
  get catalog(): Catalog {
    return {
      ...this.#catalog,
      entries: this.#entries.map((entry) => ({ ...entry })),
      glossary: this.#glossary.map((term) => ({ ...term })),
    };
  }

  /** Entries the run gave up on, by id, in catalog order. */
  get failed(): ReadonlyArray<string> {
    return this.#entries.filter((entry) => this.#failed.has(entry.id)).map((e) => e.id);
  }

  term(source: string): DraftTerm | undefined {
    return this.#terms.get(source.trim());
  }

  #guess<A>(value: A) {
    return { value, ...(this.#run !== undefined && { run: this.#run }) };
  }

  #add(term: DraftTerm) {
    this.#glossary.push(term);
    this.#terms.set(term.source, term);
  }

  /**
   * Adds a term for a name and the run's English, unless the glossary has one. Its kind is the
   * rules' guess, for the model to check.
   */
  addTerm(source: string, translation: string, fromOrigin: boolean): DraftTerm | undefined {
    const trimmedSource = source.trim();
    const trimmedTranslation = translation.trim();
    if (!hasWords(trimmedSource) || !trimmedTranslation || this.#terms.has(trimmedSource))
      return undefined;
    const named = nameTerm(trimmedSource, trimmedTranslation, fromOrigin, this.language);
    const term: DraftTerm = {
      source: named.source,
      translation: { guess: this.#guess(named.translation) },
      kind: { guess: { value: named.kind } },
    };
    this.#add(term);
    return term;
  }

  /** Adds a term for a translated name entry, unless the glossary has one. */
  seedTerm(entry: RunEntry) {
    this.#seed(entry, entryTranslation(entry));
  }

  /**
   * Adds the entry's translation to the glossary, without its tags. Gives the new term when
   * the entry's translation should be the term's.
   */
  #seed(entry: RunEntry, translation: string): DraftTerm | undefined {
    if (!this.keepsTags(entry)) return this.addTerm(entry.source, translation, isOriginName(entry));
    this.addTerm(withoutTags(entry.source), withoutTags(translation), isOriginName(entry));
    return undefined;
  }

  /** Whether the entry's tags stay as they are, kept aside from requests. */
  keepsTags(entry: Placed) {
    return keepsTags(this.#catalog.game.engine, entry);
  }

  /** Adds the names the model found, such as Claude's reading of the game, with its kinds. */
  addTerms(names: ReadonlyArray<NamedTerm>) {
    for (const { source, translation, kind } of names)
      if (!this.#terms.has(source))
        this.#add({
          source,
          translation: { guess: this.#guess(translation) },
          kind: { guess: this.#guess(kind) },
        });
  }

  /**
   * The entry's source as a request sends it. In a message, a first line that is only a
   * glossary term or the speaker's name is the speaker, kept aside from the text.
   */
  prepare(entry: RunEntry): Prepared {
    const request = requestText(entry, undefined, this.keepsTags(entry));
    if (!isMessage(entry)) return { entry, ...request };
    const tag = speakerTagName(request.leading);
    return {
      entry,
      ...requestText(entry, (name) =>
        tag === undefined
          ? this.term(name) !== undefined || name === this.#showTextSpeaker(entry)
          : name === tag,
      ),
    };
  }

  /** The speaker's source name: from a speaker tag or first line at the text's start, or the Show Text's. */
  speakerName(item: Prepared): string | undefined {
    return speakerTagName(item.leading) ?? item.speakerLine ?? this.#showTextSpeaker(item.entry);
  }

  /** The speaker as requests name them: in English when the glossary has the name. */
  speaker(item: Prepared): string | undefined {
    const name = this.speakerName(item);
    const term = name === undefined ? undefined : this.term(name);
    return term ? termTranslation(term) : name;
  }

  /** How many characters the entry has room for in its image. */
  limit(entry: Pick<Entry, "id">): number | undefined {
    return this.#limits.get(entry.id);
  }

  /**
   * The limit when it is worth telling the model: English runs about three and a half characters
   * per Chinese one in short labels (鉴赏 → Gallery, 物理攻击 → Physical Attack) and about half that
   * per kana or Hangul syllable (はい → Yes, 저장 → Save), so only a room no larger than that.
   */
  tightLimit(item: Prepared): number | undefined {
    const limit = this.limit(item.entry);
    if (limit === undefined) return undefined;
    let natural = 0;
    for (const char of item.text.replace(/\{\d+\}|\s/g, ""))
      natural += han.test(char) ? 3.5 : sourceScript.test(char) ? 1.75 : 1;
    return limit <= natural ? limit : undefined;
  }

  /** What the run knows about an entry when it checks its answer. */
  answerContext(item: Prepared): AnswerContext {
    const source = this.speakerName(item);
    const translation = this.speaker(item);
    const limit = this.limit(item.entry);
    return {
      glossary: this.#glossary.flatMap((term) => {
        const english = termTranslation(term);
        return sourceScript.test(english) ? [{ source: term.source, translation: english }] : [];
      }),
      ...(source && translation && { speaker: { source, translation } }),
      ...(limit !== undefined && { limit }),
    };
  }

  /** The text with the speaker's names in English, where the glossary has them. */
  #withSpeakerNames(item: Prepared, text: string) {
    const tagged = text.replace(speakerTagPattern, (tag, name: string) => {
      const term = this.term(name);
      const translation = term && termTranslation(term);
      return translation === undefined ? tag : tag.replace(/<[^>]*>/, () => `<${translation}>`);
    });
    const name = item.speakerLine;
    const english = name === undefined ? undefined : this.speaker(item);
    if (name === undefined || english === undefined || !tagged.startsWith(item.leading))
      return tagged;
    const at = item.leading.lastIndexOf(name);
    return item.leading.slice(0, at) + english + tagged.slice(at + name.length);
  }

  /**
   * Takes a translation for the entry and for every untranslated copy of its text. The first
   * accepted copy of repeated text sets the translation of every copy, flag and all.
   */
  accept(item: Prepared, translation: string, { flag, long, seedGlossary }: Accepted = {}) {
    const { entry } = item;
    const known = this.#reuse.known(entry);
    let result = known ?? this.#withSpeakerNames(item, translation);
    if (seedGlossary) {
      const term = this.#seed(entry, result);
      if (term) result = termTranslation(term);
    }
    entry.translation = withGuess(entry.translation, {
      ...this.#guess(result),
      ...(known === undefined && flag && { flag }),
      ...(known === undefined &&
        long !== undefined && { long: this.#withSpeakerNames(item, long) }),
    });
    if (entry.previous === result) delete entry.previous;
    delete entry.suggestion;
    for (const filled of this.#reuse.spread(entry)) this.#failed.delete(filled.id);
  }

  /** Keeps a rejected answer on the entry, with its control codes back, for the user to fix. */
  suggest(item: Prepared, answer: string, reason: RejectReason) {
    item.entry.suggestion = {
      text: this.#withSpeakerNames(
        item,
        answerSuggestion(item, answer, this.answerContext(item).speaker),
      ),
      reason,
    };
  }

  fail(entry: Pick<Entry, "id">) {
    this.#failed.add(entry.id);
  }

  /**
   * Terms the model hasn't sorted by kind yet, with what the kind question sends about each. Terms
   * the user sorted or gave a pronoun stay as they are.
   */
  termsToSort(): ReadonlyArray<{ readonly term: DraftTerm; readonly input: TermInput }> {
    const terms = this.#glossary.filter(
      (term) =>
        hasWords(term.source) &&
        term.kind.guess.run === undefined &&
        term.kind.user === undefined &&
        term.pronoun?.user === undefined,
    );
    const inputs = termInputs(this.#entries, terms);
    return terms.flatMap((term, index) => {
      const input = inputs[index];
      return input ? [{ term, input }] : [];
    });
  }

  /** Gives the term the kind the model chose. A term that stops being a character loses its pronoun. */
  setKind(term: DraftTerm, kind: TermKind) {
    if (kind !== "character" || termKind(term) !== "character") delete term.pronoun;
    term.kind = { guess: this.#guess(kind) };
  }

  /**
   * Gives every character without a pronoun the one the text's clues show, and lists those the
   * clues leave unknown with the lines that tell about them, for the model to decide. A pronoun
   * the clues left unknown is checked again; the model's and the user's stay. A single Chinese
   * character is mostly a word inside other words, so it gets none.
   */
  pronounsFromClues(): ReadonlyArray<{
    readonly term: DraftTerm;
    readonly lines: ReadonlyArray<string>;
  }> {
    const names = this.#glossary.filter(
      (term) =>
        termKind(term) === "character" &&
        hasWords(term.source) &&
        Array.from(term.source.trim()).length >= 2,
    );
    const unset = names.filter(
      ({ pronoun }) =>
        !pronoun ||
        (pronoun.user === undefined &&
          pronoun.guess?.run === undefined &&
          pronoun.guess?.value === "unknown"),
    );
    if (!unset.length) return [];
    const clues = collectClues(
      this.#entries,
      names.map((term) => term.source.trim()),
      this.language,
    );
    return unset.flatMap((term) => {
      const found = clues.get(term.source.trim());
      if (!found) return [];
      const guess = pronounFromClues(found);
      term.pronoun = { guess };
      if (guess.value !== "unknown") return [];
      const { lines } = linesAbout(
        this.#entries,
        term.source.trim(),
        this.#glossary,
        this.language,
      );
      return lines.length ? [{ term, lines }] : [];
    });
  }

  /** Takes the pronoun the model decided, keeping the clues' counts. */
  setPronoun(term: DraftTerm, value: PronounValue) {
    term.pronoun = { guess: { ...term.pronoun?.guess, ...this.#guess(value) } };
  }
}
