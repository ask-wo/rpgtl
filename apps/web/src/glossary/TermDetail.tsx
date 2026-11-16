import type { GlossaryTerm, PronounValue, TermKind, Text } from "@rpgtl/contracts";
import {
  characterAliases,
  doubted,
  type EntryText,
  shortNameTranslations,
  termKind,
  termPronoun,
  termTexts,
  textsToClear,
  translationInUse,
  withoutStrayPronoun,
} from "@rpgtl/domain";
import * as Struct from "effect/Struct";
import { Button } from "~/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { useState } from "react";
import { ChoiceField } from "../translation/ChoiceField.tsx";
import type { Choice } from "../translation/choices.ts";
import { counted, number } from "../translation/counts.ts";

const kinds: ReadonlyArray<Choice<TermKind>> = [
  { value: "character", label: "Character" },
  { value: "name", label: "Name" },
  { value: "word", label: "Word" },
];

const pronouns: ReadonlyArray<Choice<PronounValue>> = [
  { value: "she", label: "she" },
  { value: "he", label: "he" },
  { value: "unknown", label: "unknown" },
];

/** How long typing pauses before the glossary saves. */
const typingPause = 600;

/** The entries of the term's own that the page lists; the count covers all of them. */
const listed = 100;

/** Who sorted the term. */
const kindOrigin = ({ userKind, modelKind }: GlossaryTerm) =>
  userKind !== undefined
    ? "Set by you."
    : modelKind !== undefined
      ? "Sorted by the model."
      : "Not checked yet.";

/** Where the pronoun came from; a model's answer the text's clues argue against waits for you. */
const pronounFrom = (term: GlossaryTerm) => {
  if (term.userPronoun !== undefined) return "Set by you.";
  const clues = `${term.sheClues ?? 0} clues for she, ${term.heClues ?? 0} for he`;
  if (term.modelPronoun !== undefined)
    return doubted(term)
      ? `From the model, but the text has ${clues}. Translations don't use it until you confirm it.`
      : "From the model.";
  if (term.rulesPronoun !== undefined) return `From the text: ${clues}.`;
  return "Not checked yet.";
};

/** The term with the English the user typed; English equal to the run's isn't kept as theirs. */
const withTypedEnglish = (term: GlossaryTerm, typed: string): GlossaryTerm => {
  const rest = Struct.omit(term, ["userTranslation"]);
  return typed === term.modelTranslation ? rest : { ...rest, userTranslation: typed };
};

/** The guess a user value replaced, with a button that goes back to it. */
function Restore({
  label,
  guess,
  onRestore,
}: {
  readonly label: string;
  readonly guess: string;
  readonly onRestore: () => void;
}) {
  return (
    <p className="text-sm text-muted-foreground">
      {label} <span className="text-foreground">{guess}</span>{" "}
      <Button variant="link" size="xs" onClick={onRestore}>
        Use it
      </Button>
    </p>
  );
}

const guessLabel = (byModel: boolean, what: string) =>
  byModel ? `The run's ${what}:` : `RPGTL's ${what}:`;

/** The short forms of a name that "Used in" counts, as ", counting its short form 美咲". */
const counting = (shortForms: ReadonlyArray<string>) =>
  shortForms.length === 0
    ? ""
    : `, counting its short ${shortForms.length === 1 ? "form" : "forms"} ${shortForms.join(" and ")}`;

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ");

/** A glossary term to correct, and the entries that use it or a short form of its name. */
export function TermDetail({
  term,
  glossary,
  entries,
  texts: savedTexts,
  lastRun,
  missing,
  locked,
  onChange,
  onDone,
  onClearAll,
  onClearMismatches,
}: {
  readonly term: GlossaryTerm;
  readonly glossary: ReadonlyArray<GlossaryTerm>;
  readonly entries: ReadonlyArray<EntryText>;
  readonly texts: ReadonlyArray<Text>;
  /** The operation id of the last run that gave a text its English. */
  readonly lastRun: number | undefined;
  /** The names inside the term whose English its English leaves out, as `source → English`. */
  readonly missing: ReadonlyArray<string>;
  readonly locked: boolean;
  /** Saves after `delay` ms, so typing saves once it pauses. */
  readonly onChange: (term: GlossaryTerm, delay: number) => void;
  /** Saves what was typed now. */
  readonly onDone: () => void;
  /** Asks before clearing every line with the term. */
  readonly onClearAll: () => void;
  readonly onClearMismatches: () => void;
}) {
  const source = term.source.trim();
  const translation = translationInUse(term);
  const { previousTranslation: previous, modelTranslation: model } = term;
  const kind = termKind(term);
  const kindGuess = term.modelKind ?? term.rulesKind;
  const pronounGuess = term.modelPronoun ?? term.rulesPronoun;
  const pronoun = termPronoun(term);
  const texts = termTexts(term, shortNameTranslations(glossary), characterAliases(glossary));
  const uses = entries.filter((entry) => texts.some((text) => entry.source.includes(text)));
  const [showAll, setShowAll] = useState(false);
  const translated = textsToClear({ texts: savedTexts, glossary }, term, false).length;
  return (
    <div
      inert={locked}
      aria-disabled={locked}
      className="flex max-w-3xl flex-col gap-6 aria-disabled:opacity-60"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="text-2xl">{term.source || "New term"}</div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={locked || !source || !translation.trim()}
            onClick={onClearMismatches}
          >
            Clear wrong text
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            disabled={locked || translated === 0}
            onClick={onClearAll}
          >
            Clear all text…
          </Button>
        </div>
      </div>
      {source && (
        <p className="-mt-4 text-sm text-muted-foreground">
          {translation.trim() &&
            `Clearing wrong text removes the translation of all lines with ${source} that don't also contain "${translation.trim()}". `}
          Clearing all text removes the translation of every line with {source}.
        </p>
      )}
      <div className="grid grid-cols-2 items-start gap-4">
        <Field>
          <FieldLabel htmlFor="term-source">Original</FieldLabel>
          <Input
            id="term-source"
            value={term.source}
            autoFocus={!term.source}
            onChange={(event) => onChange({ ...term, source: event.target.value }, typingPause)}
            onBlur={onDone}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="term-translation">English</FieldLabel>
          <Input
            id="term-translation"
            value={translation}
            onChange={(event) => onChange(withTypedEnglish(term, event.target.value), typingPause)}
            onBlur={onDone}
          />
          {model !== undefined && term.userTranslation !== undefined && (
            <Restore
              label={guessLabel(true, "English")}
              guess={model}
              onRestore={() => onChange(Struct.omit(term, ["userTranslation"]), 0)}
            />
          )}
          {previous && previous !== translation && (
            <Restore
              label={
                !translation
                  ? "Before clearing:"
                  : lastRun !== undefined && term.modelOperationId === lastRun
                    ? "Before the last run:"
                    : "Before:"
              }
              guess={previous}
              onRestore={() => onChange(withTypedEnglish(term, previous), 0)}
            />
          )}
          {missing.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Leaves out the English of a name inside it: {missing.join(", ")}
            </p>
          )}
        </Field>
        <div className="flex flex-col gap-1">
          <ChoiceField
            id="term-kind"
            label="Kind"
            value={kind}
            choices={kinds}
            onChoose={(chosen) => onChange(withoutStrayPronoun({ ...term, userKind: chosen }), 0)}
          />
          <FieldDescription>{kindOrigin(term)}</FieldDescription>
          {term.userKind !== undefined && term.userKind !== kindGuess && (
            <Restore
              label={guessLabel(term.modelKind !== undefined, "kind")}
              guess={kindGuess}
              onRestore={() => onChange(withoutStrayPronoun(Struct.omit(term, ["userKind"])), 0)}
            />
          )}
        </div>
        {kind === "character" && (
          <div className="flex flex-col gap-1">
            <ChoiceField
              id="term-pronoun"
              label="Pronoun"
              value={pronoun ?? "unknown"}
              choices={pronouns}
              onChoose={(value) => onChange({ ...term, userPronoun: value }, 0)}
            />
            <FieldDescription>{pronounFrom(term)}</FieldDescription>
            {term.modelPronoun !== undefined && doubted(term) && (
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() =>
                  term.modelPronoun !== undefined &&
                  onChange({ ...term, userPronoun: term.modelPronoun }, 0)
                }
              >
                Confirm {term.modelPronoun}
              </Button>
            )}
            {pronounGuess !== undefined &&
              term.userPronoun !== undefined &&
              term.userPronoun !== pronounGuess && (
                <Restore
                  label={guessLabel(term.modelPronoun !== undefined, "pronoun")}
                  guess={pronounGuess}
                  onRestore={() => onChange(Struct.omit(term, ["userPronoun"]), 0)}
                />
              )}
          </div>
        )}
      </div>
      <section aria-label="Entries that use the term" className="flex flex-col gap-2 text-sm">
        <h3 className="font-medium">
          {source
            ? `Used in ${counted(uses.length, "entry", "entries")}${counting(texts.slice(1))}`
            : "Type the original to see where the game uses it"}
        </h3>
        {(showAll ? uses : uses.slice(0, listed)).map((entry) => (
          <div
            key={entry.id}
            className="grid grid-cols-2 gap-4 border-b py-1.5 [contain-intrinsic-size:auto_2rem] [content-visibility:auto]"
          >
            <span>{oneLine(entry.source)}</span>
            <span className={translationInUse(entry) ? undefined : "text-muted-foreground italic"}>
              {translationInUse(entry) ? oneLine(translationInUse(entry)) : "Not translated"}
            </span>
          </div>
        ))}
        {!showAll && uses.length > listed && (
          <Button
            variant="link"
            size="sm"
            className="self-start px-0"
            onClick={() => setShowAll(true)}
          >
            Show the other {number(uses.length - listed)}
          </Button>
        )}
      </section>
    </div>
  );
}
