import type { ReactNode } from "react";
import { Field, FieldLabel } from "~/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import type { Choice } from "./choices.ts";

/** A labelled select that saves its choice as soon as it is made. */
export function ChoiceField<V extends string | number>({
  id,
  label,
  value,
  choices,
  onChoose,
  action,
  labelHidden = false,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: V;
  readonly choices: ReadonlyArray<Choice<V>>;
  readonly onChoose: (value: V) => void;
  /** A button beside the select, such as one that reloads its choices. */
  readonly action?: ReactNode;
  /** Keeps the label for screen readers only, where the text around the select says what it is. */
  readonly labelHidden?: boolean;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id} className={labelHidden ? "sr-only" : undefined}>
        {label}
      </FieldLabel>
      <Select
        items={choices}
        value={value}
        onValueChange={(next) => {
          if (next !== null && next !== value) onChoose(next);
        }}
      >
        <div className="flex gap-2">
          <SelectTrigger id={id} className="w-full min-w-0 flex-1">
            <SelectValue />
          </SelectTrigger>
          {action}
        </div>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value} disabled={choice.disabled}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
