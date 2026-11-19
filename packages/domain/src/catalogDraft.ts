import type {
  AnswerContext,
  Catalog,
  Entry,
  GameSettings,
  PronounValue,
  RejectReason,
  SourceLanguage,
  GlossaryTerm,
  TermKind,
  Text,
} from "@rpgtl/contracts";
import * as Struct from "effect/Struct";
import type * as Types from "effect/Types";
import { answerSuggestion } from "./answers.ts";
import { sourceScript } from "./checks.ts";
import { speakerTagName, speakerTagPattern } from "./controlCodes.ts";
import { type EntryText, entryTexts } from "./catalog.ts";
import { termKind, termPronoun, translationInUse, withModelTranslation } from "./inUse.ts";
import { keepsTags, withoutTags } from "./engines/xp/databaseTags.ts";
import { builtinTranslationLimit } from "./engines/xp/englishBranches.ts";
import { gameLanguage } from "./language.ts";
import { isImageText, isMessage, isScriptText, type Placed } from "./location.ts";
import { isActorName, isSpeakerNameEntry } from "./nameEntries.ts";
import { nameTerm } from "./nameTerm.ts";
import { collectClues, linesAbout, pronounFromClues } from "./pronouns.ts";
import { type RequestText, requestText, withoutCodes } from "./requestText.ts";
import { slotKind } from "./slotKinds.ts";
import { type TermInput, termInputs } from "./termKinds.ts";

const hasWords = (source: string) => withoutCodes(source).trim() !== "";

/**
 * Whether a run translates the entry: all but those the user leaves untranslated, the text of
 * images the game shows as they are, and script text while the game plays its scripts unchanged.
 */
export const runTranslates =
  ({ untranslatedImages, isScriptTranslationOn }: GameSettings) =>
  (entry: Pick<Entry, "isLeftUntranslated"> & Placed) =>
    !entry.isLeftUntranslated &&
    !(isImageText(entry) && untranslatedImages.includes(entry.location.image)) &&
    !(!isScriptTranslationOn && isScriptText(entry));

/** The fields of a text that a run writes. */
type TextValues = Partial<Omit<Text, "id" | "source" | "speaker" | "isInImage">>;
const textFields = [
  "modelTranslation",
  "modelOperationId",
  "unshortenedTranslation",
  "flagReason",
  "rejectedTranslation",
  "rejectionReason",
  "userTranslation",
] as const satisfies ReadonlyArray<keyof TextValues>;

/** An entry with its text, which a run fills in; every entry of the text changes with it. */
export type DraftEntry = Types.Mutable<EntryText>;
/**
 * An entry a run asks about: one of the draft's, or a speaker's name that lives only for the run
 * and has no text.
 */
export type RunEntry = Types.Mutable<Omit<EntryText, "location" | "textId">> &
  Partial<Pick<EntryText, "textId">> &
  Placed;
/** A glossary term a run fills in; one the run adds has an id below 0 until it is saved. */
export type DraftTerm = Types.Mutable<Omit<GlossaryTerm, "id">> & { readonly id: number };

/** What a run changed since it last asked: texts by id, and terms. */
export interface DraftChanges {
  readonly texts: ReadonlyArray<Pick<Text, "id"> & TextValues>;
  readonly terms: ReadonlyArray<DraftTerm>;
}

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
  /** The first answer, when the translation is a shorter second one that fits where the game draws it. */
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
  readonly #copies = new Map<number, Array<DraftEntry>>();
  readonly #terms: Array<DraftTerm>;
  readonly #termsBySource: Map<string, DraftTerm>;
  readonly #limits: ReadonlyMap<string, number>;
  readonly #failed = new Set<string>();
  readonly #changedTexts = new Set<number>();
  readonly #changedTerms = new Set<DraftTerm>();

  /** `limits` is how many characters each image entry has room for, by entry id. */
  constructor(catalog: Catalog, limits: ReadonlyMap<string, number>) {
    this.#catalog = catalog;
    this.language = gameLanguage(catalog);
    this.#entries = entryTexts(catalog);
    for (const entry of this.#entries) {
      const copies = this.#copies.get(entry.textId);
      if (copies) copies.push(entry);
      else this.#copies.set(entry.textId, [entry]);
    }
    this.#terms = catalog.glossary.map((term) => ({ ...term }));
    this.#termsBySource = new Map(this.#terms.map((term) => [term.source, term]));
    this.#limits = limits;
  }

  get entries(): ReadonlyArray<DraftEntry> {
    return this.#entries;
  }

  /** The glossary; sorting terms and finding pronouns change its terms in place. */
  get glossary(): ReadonlyArray<DraftTerm> {
    return this.#terms;
  }

  /** The entries a run translates. */
  get translatable(): ReadonlyArray<DraftEntry> {
    return this.#entries.filter(runTranslates(this.#catalog.settings));
  }

  /** The texts and terms the draft changed since the last call. */
  takeChanges(): DraftChanges {
    const texts = [...this.#changedTexts].flatMap((id) => {
      const entry = this.#copies.get(id)?.[0];
      if (!entry) return [];
      return [{ id, ...Struct.pick(entry, textFields) }];
    });
    const terms = [...this.#changedTerms];
    this.#changedTexts.clear();
    this.#changedTerms.clear();
    return { texts, terms };
  }

  /** Gives the entry's text, and so every entry of it, the values `f` makes of its own. */
  #change(entry: RunEntry, f: (values: TextValues) => TextValues) {
    const next = f(Struct.pick(entry, textFields));
    const copies = (entry.textId === undefined ? undefined : this.#copies.get(entry.textId)) ?? [
      entry,
    ];
    for (const copy of copies) {
      for (const field of textFields) delete copy[field];
      Object.assign(copy, next);
    }
    if (entry.textId !== undefined) this.#changedTexts.add(entry.textId);
    return copies;
  }

  /** Entries the run gave up on, by id, in catalog order. */
  get failed(): ReadonlyArray<string> {
    return this.#entries.filter((entry) => this.#failed.has(entry.id)).map((e) => e.id);
  }

  hasFailed(id: string) {
    return this.#failed.has(id);
  }

  term(source: string): DraftTerm | undefined {
    return this.#termsBySource.get(source.trim());
  }

  #add(term: DraftTerm) {
    this.#terms.push(term);
    this.#termsBySource.set(term.source, term);
    this.#changedTerms.add(term);
  }

  /** The term for the source, when it has English. */
  translatedTerm(source: string): DraftTerm | undefined {
    const term = this.term(source);
    return term && translationInUse(term) ? term : undefined;
  }

  /** Gives a term without English the model's English, keeping its kind and pronoun. */
  #fill(term: DraftTerm, translation: string) {
    delete term.modelOperationId;
    delete term.previousTranslation;
    term.modelTranslation = translation;
    this.#changedTerms.add(term);
    return term;
  }

  /**
   * Adds a term for a name and the model's English, unless the glossary has one with English. Its
   * kind is the rules', for the model to check.
   */
  addTerm(source: string, translation: string, fromOrigin: boolean): DraftTerm | undefined {
    const trimmedSource = source.trim();
    const trimmedTranslation = translation.trim();
    if (!hasWords(trimmedSource) || !trimmedTranslation || this.translatedTerm(trimmedSource))
      return undefined;
    const named = nameTerm(trimmedSource, trimmedTranslation, fromOrigin, this.language);
    const existing = this.term(named.source);
    if (existing) return this.#fill(existing, named.translation);
    const term: DraftTerm = {
      id: Math.min(0, ...this.#terms.map((each) => each.id)) - 1,
      source: named.source,
      modelTranslation: named.translation,
      rulesKind: named.kind,
    };
    this.#add(term);
    return term;
  }

  /** Adds a term for a translated name entry, unless the glossary has one. */
  seedTerm(entry: RunEntry) {
    this.#seed(entry, translationInUse(entry));
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
        tag === undefined ? this.term(name) !== undefined || name === entry.speaker : name === tag,
      ),
    };
  }

  /** The speaker's source name: from a speaker tag or first line at the text's start, or the Show Text's. */
  speakerName(item: Prepared): string | undefined {
    return speakerTagName(item.leading) ?? item.speakerLine ?? item.entry.speaker;
  }

  /** The speaker as requests name them: in English when the glossary has the name. */
  speaker(item: Prepared): string | undefined {
    const name = this.speakerName(item);
    const term = name === undefined ? undefined : this.translatedTerm(name);
    return term ? translationInUse(term) : name;
  }

  /**
   * Each placeholder of the item with the code it stands for and, when the engine says, what the
   * game puts there: `{"{1}": "\\N[2]: a character's name, Belka"}`.
   */
  placeholders(item: Prepared): Record<string, string> | undefined {
    if (!item.codes.length) return undefined;
    const engine = this.#catalog.game.engine;
    return Object.fromEntries(
      item.codes.map((code, at) => {
        const kind = slotKind(code, item.entry, engine);
        const actor = /^\\N\[(\d+)\]$/i.exec(code)?.[1];
        const name = actor === undefined ? undefined : this.#actorName(Number(actor));
        return [
          `{${at + 1}}`,
          kind === undefined ? code : `${code}: ${kind}${name ? `, ${name}` : ""}`,
        ];
      }),
    );
  }

  /** An actor's name in English, when the run has it. */
  #actorName(actor: number) {
    const entry = this.#entries.find(
      ({ location }) =>
        location._tag === "RecordField" &&
        location.table === "actors" &&
        location.record === actor &&
        location.field === "name",
    );
    if (!entry) return undefined;
    const term = this.translatedTerm(entry.source);
    const english = term ? translationInUse(term) : translationInUse(entry);
    return english && !sourceScript.test(english) ? english : undefined;
  }

  /** How many characters the entry has room for where the game draws it, when that is known. */
  limit(entry: Pick<EntryText, "id" | "source" | "builtinTranslation">): number | undefined {
    return this.#limits.get(entry.id) ?? builtinTranslationLimit(entry);
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
      glossary: this.#terms.flatMap((term) => {
        const english = translationInUse(term);
        return sourceScript.test(english) ? [{ source: term.source, translation: english }] : [];
      }),
      ...(source && translation && { speaker: { source, translation } }),
      ...(limit !== undefined && { limit }),
    };
  }

  /** The text with the speaker's names in English, where the glossary has them. */
  #withSpeakerNames(item: Prepared, text: string) {
    const tagged = text.replace(speakerTagPattern, (tag, name: string) => {
      const term = this.translatedTerm(name);
      const translation = term && translationInUse(term);
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
   * Takes the model's translation for the entry's text, which every entry of the text shows. When
   * another entry of the text was accepted first, its translation stays, flag and all.
   */
  accept(item: Prepared, translation: string, { flag, long, seedGlossary }: Accepted = {}) {
    const { entry } = item;
    const known = translationInUse(entry) || undefined;
    let result = known ?? this.#withSpeakerNames(item, translation);
    if (seedGlossary) {
      const term = this.#seed(entry, result);
      if (term) result = translationInUse(term);
    }
    if (known !== undefined) return;
    const copies = this.#change(entry, (values) =>
      withModelTranslation(values, {
        modelTranslation: result,
        ...(flag && { flagReason: flag }),
        ...(long !== undefined && { unshortenedTranslation: this.#withSpeakerNames(item, long) }),
      }),
    );
    for (const copy of copies) this.#failed.delete(copy.id);
  }

  /** Keeps a rejected answer on the entry's text, with its control codes back, for the user to fix. */
  suggest(item: Prepared, answer: string, reason: RejectReason) {
    const rejectedTranslation = this.#withSpeakerNames(
      item,
      answerSuggestion(item, answer, this.answerContext(item).speaker),
    );
    this.#change(item.entry, (values) => ({
      ...values,
      rejectedTranslation,
      rejectionReason: reason,
    }));
  }

  fail(entry: Pick<Entry, "id">) {
    this.#failed.add(entry.id);
  }

  /**
   * Terms the model hasn't sorted by kind yet, with what the kind question sends about each. Terms
   * the user sorted or gave a pronoun stay as they are.
   */
  termsToSort(): ReadonlyArray<{ readonly term: DraftTerm; readonly input: TermInput }> {
    const terms = this.#terms.filter(
      (term) =>
        hasWords(term.source) &&
        term.modelKind === undefined &&
        term.userKind === undefined &&
        term.userPronoun === undefined,
    );
    const inputs = termInputs(this.#entries, terms);
    return terms.flatMap((term, index) => {
      const input = inputs[index];
      return input ? [{ term, input }] : [];
    });
  }

  /** Gives the term the kind the model chose. A term that stops being a character loses its pronoun. */
  setKind(term: DraftTerm, kind: TermKind) {
    if (kind !== "character" || termKind(term) !== "character") {
      delete term.rulesPronoun;
      delete term.sheClues;
      delete term.heClues;
      delete term.modelPronoun;
    }
    term.modelKind = kind;
    this.#changedTerms.add(term);
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
    const names = this.#terms.filter(
      (term) =>
        termKind(term) === "character" &&
        hasWords(term.source) &&
        Array.from(term.source.trim()).length >= 2,
    );
    const unset = names.filter(
      (term) =>
        termPronoun(term) === undefined ||
        (term.userPronoun === undefined &&
          term.modelPronoun === undefined &&
          term.rulesPronoun === "unknown"),
    );
    if (!unset.length) return [];
    const clues = collectClues(
      this.#entries,
      names.map((term) => term.source.trim()),
      this.language,
    );
    let about: ReturnType<typeof linesAbout> | undefined;
    return unset.flatMap((term) => {
      const found = clues.get(term.source.trim());
      if (!found) return [];
      const { pronoun, she, he } = pronounFromClues(found);
      term.rulesPronoun = pronoun;
      term.sheClues = she;
      term.heClues = he;
      this.#changedTerms.add(term);
      if (pronoun !== "unknown") return [];
      about ??= linesAbout(this.#entries, this.#terms, this.language);
      const { lines } = about(term.source.trim());
      return lines.length ? [{ term, lines }] : [];
    });
  }

  /** Takes the pronoun the model decided, keeping the clues' counts. */
  setPronoun(term: DraftTerm, value: PronounValue) {
    term.modelPronoun = value;
    this.#changedTerms.add(term);
  }
}
