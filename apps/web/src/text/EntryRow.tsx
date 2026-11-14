import type { Entry } from "@rpgtl/contracts";
import { canKeepOriginal, entryTranslation } from "@rpgtl/domain";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Field, FieldLabel } from "~/components/ui/field";
import { Textarea } from "~/components/ui/textarea";

/** An entry's original beside its English, with what a run or a check left for the user. */
export function EntryRow({
  entry,
  value,
  where,
  speaker,
  notes,
  fromLastRun,
  error,
  locked,
  onChange,
  onKeepOriginal,
}: {
  readonly entry: Entry;
  /** The English as typed here, saved or not. */
  readonly value: string;
  /** The entry's file, as the tree names it. */
  readonly where: string;
  /** Who says it, in English where the glossary has the name. */
  readonly speaker: string | undefined;
  /** Why the saved English is worth a look. */
  readonly notes: ReadonlyArray<string>;
  readonly fromLastRun: boolean;
  /** Why the typed English couldn't be saved. */
  readonly error: string | undefined;
  readonly locked: boolean;
  /** Saves the English after `delay` ms, so typing saves once it pauses. */
  readonly onChange: (translation: string, delay: number) => void;
  readonly onKeepOriginal: (keep: boolean) => void;
}) {
  const edited = value !== entryTranslation(entry);
  const { suggestion, previous } = entry;
  const { guess } = entry.translation;
  return (
    <div
      className="grid grid-cols-2 gap-4 border-b px-6 py-3"
      role="group"
      aria-label={entry.source}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-xs text-muted-foreground">
          {where}
          {speaker && ` · ${speaker}`}
        </p>
        <p className="text-sm break-words whitespace-pre-wrap">{entry.source}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Textarea
          className="min-h-9"
          value={value}
          disabled={locked}
          placeholder="Translation"
          aria-label={`English for ${entry.source}`}
          aria-invalid={error !== undefined || undefined}
          onChange={(event) => onChange(event.target.value, typingPause)}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        {canKeepOriginal(entry) && (
          <Field orientation="horizontal">
            <Checkbox
              id={`keep-original-${entry.id}`}
              checked={entry.keepOriginal === true}
              disabled={locked}
              onCheckedChange={onKeepOriginal}
            />
            <FieldLabel htmlFor={`keep-original-${entry.id}`}>Keep original</FieldLabel>
          </Field>
        )}
        {!value && suggestion && (
          <Note label={`Rejected answer (${suggestion.reason}):`} text={suggestion.text}>
            <Button
              variant="link"
              size="xs"
              disabled={locked}
              title="Copies it into the English to fix it there"
              onClick={() => onChange(suggestion.text, 0)}
            >
              Use
            </Button>
          </Note>
        )}
        {guess && value !== guess.value && (
          <Note label={guess.run ? "The run's answer:" : "RPGTL's English:"} text={guess.value}>
            <Button
              variant="link"
              size="xs"
              disabled={locked}
              title="Puts it back in place of your English"
              onClick={() => onChange(guess.value, 0)}
            >
              Use it
            </Button>
          </Note>
        )}
        {previous && value !== previous && (!value || fromLastRun) && (
          <Note label={value ? "Before the last run:" : "Before clearing:"} text={previous}>
            <Button
              variant="link"
              size="xs"
              disabled={locked}
              onClick={() => onChange(previous, 0)}
            >
              Use the old one
            </Button>
          </Note>
        )}
        {!edited && value && notes.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Check: {notes.join("; ")}. Editing the English clears this.
          </p>
        )}
      </div>
    </div>
  );
}

/** How long typing pauses before the entry saves. */
const typingPause = 600;

function Note({
  label,
  text,
  children,
}: {
  readonly label: string;
  readonly text: string;
  readonly children: React.ReactNode;
}) {
  return (
    <p className="text-sm text-muted-foreground">
      {label} <span className="text-foreground">{text}</span> {children}
    </p>
  );
}
