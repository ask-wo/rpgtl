import type { Entry, GlossaryTerm, Pronoun, PronounValue, TermKind } from "@rpgtl/contracts";
import {
  characterAliases,
  doubted,
  entriesToClear,
  entryTranslation,
  restored,
  shortNameTranslations,
  termTranslation,
  termKind,
  termPronoun,
  termTexts,
  withoutStrayPronoun,
  withUser,
} from "@rpgtl/domain";
import { Button } from "~/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
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

/** Who sorted the term, and the guess to go back to when the user chose another kind. */
const kindOrigin = ({ kind }: GlossaryTerm) =>
  kind.user !== undefined
    ? "Set by you."
    : kind.guess.run !== undefined
      ? "Sorted by the model."
      : "Not checked yet.";

/** Where the pronoun came from; a model's answer the text's clues argue against waits for you. */
const pronounFrom = (pronoun: Pronoun | undefined) => {
  if (!pronoun) return "Not checked yet.";
  if (pronoun.user !== undefined) return "Set by you.";
  const { guess } = pronoun;
  if (!guess) return "Not checked yet.";
  const clues = `${guess.she ?? 0} clues for she, ${guess.he ?? 0} for he`;
  if (guess.run === undefined) return `From the text: ${clues}.`;
  return doubted(pronoun)
    ? `From the model, but the text has ${clues}. Translations don't use it until you confirm it.`
    : "From the model.";
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

const guessLabel = (guess: { readonly run?: string }, what: string) =>
  guess.run === undefined ? `RPGTL's ${what}:` : `The run's ${what}:`;

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
  locked,
  onChange,
  onDone,
  onClearAll,
  onClearMismatches,
}: {
  readonly term: GlossaryTerm;
  readonly glossary: ReadonlyArray<GlossaryTerm>;
  readonly entries: ReadonlyArray<Entry>;
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
  const translation = termTranslation(term);
  const kind = termKind(term);
  const pronoun = termPronoun(term);
  const texts = termTexts(term, shortNameTranslations(glossary), characterAliases(glossary));
  const uses = entries.filter((entry) => texts.some((text) => entry.source.includes(text)));
  const translated = entriesToClear({ entries, glossary }, term, false).length;
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
            onChange={(event) =>
              onChange(
                { ...term, translation: withUser(term.translation, event.target.value) },
                typingPause,
              )
            }
            onBlur={onDone}
          />
          {term.translation.guess && term.translation.user !== undefined && (
            <Restore
              label={guessLabel(term.translation.guess, "English")}
              guess={term.translation.guess.value}
              onRestore={() => onChange({ ...term, translation: restored(term.translation) }, 0)}
            />
          )}
        </Field>
        <div className="flex flex-col gap-1">
          <ChoiceField
            id="term-kind"
            label="Kind"
            value={kind}
            choices={kinds}
            onChoose={(chosen) =>
              onChange(withoutStrayPronoun({ ...term, kind: { ...term.kind, user: chosen } }), 0)
            }
          />
          <FieldDescription>{kindOrigin(term)}</FieldDescription>
          {term.kind.user !== undefined && term.kind.user !== term.kind.guess.value && (
            <Restore
              label={guessLabel(term.kind.guess, "kind")}
              guess={term.kind.guess.value}
              onRestore={() =>
                onChange(withoutStrayPronoun({ ...term, kind: { guess: term.kind.guess } }), 0)
              }
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
              onChoose={(value) =>
                onChange({ ...term, pronoun: { ...term.pronoun, user: value } }, 0)
              }
            />
            <FieldDescription>{pronounFrom(term.pronoun)}</FieldDescription>
            {term.pronoun?.guess && doubted(term.pronoun) && (
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() =>
                  term.pronoun?.guess &&
                  onChange(
                    { ...term, pronoun: { ...term.pronoun, user: term.pronoun.guess.value } },
                    0,
                  )
                }
              >
                Confirm {term.pronoun.guess.value}
              </Button>
            )}
            {term.pronoun?.guess &&
              term.pronoun.user !== undefined &&
              term.pronoun.user !== term.pronoun.guess.value && (
                <Restore
                  label={guessLabel(term.pronoun.guess, "pronoun")}
                  guess={term.pronoun.guess.value}
                  onRestore={() =>
                    term.pronoun?.guess &&
                    onChange({ ...term, pronoun: { guess: term.pronoun.guess } }, 0)
                  }
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
        {uses.slice(0, listed).map((entry) => (
          <div key={entry.id} className="grid grid-cols-2 gap-4 border-b py-1.5">
            <span>{oneLine(entry.source)}</span>
            <span className={entryTranslation(entry) ? undefined : "text-muted-foreground italic"}>
              {entryTranslation(entry) ? oneLine(entryTranslation(entry)) : "Not translated"}
            </span>
          </div>
        ))}
        {uses.length > listed && (
          <p className="text-muted-foreground">and {number(uses.length - listed)} more.</p>
        )}
      </section>
    </div>
  );
}
