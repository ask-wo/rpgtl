import { useAtomSet } from "@effect/atom-react";
import { type Catalog, SourceLanguage } from "@rpgtl/contracts";
import { guessedLanguage, languageNames } from "@rpgtl/domain";
import * as Exit from "effect/Exit";
import { useMemo, useState } from "react";
import { failureMessage } from "../app/failure.ts";
import { catalogKey, setLanguage } from "./atoms.ts";
import { ChoiceField } from "./ChoiceField.tsx";
import type { Choice } from "./choices.ts";

/** The language of the game's text: the one it looks like, until the user picks another. */
export function LanguageField({
  saved,
  locked,
}: {
  readonly saved: Catalog;
  readonly locked: boolean;
}) {
  const choose = useAtomSet(setLanguage, { mode: "promiseExit" });
  const [error, setError] = useState<string>();
  const guessed = useMemo(() => guessedLanguage(saved.entries), [saved.entries]);
  const choices: ReadonlyArray<Choice<"guessed" | SourceLanguage>> = [
    { value: "guessed", label: `${languageNames[guessed]} (Automatic)` },
    ...SourceLanguage.literals.map((language) => ({
      value: language,
      label: languageNames[language],
    })),
  ];
  const change = async (value: "guessed" | SourceLanguage) => {
    setError(undefined);
    const exit = await choose({
      payload: { id: saved.game.id, language: value === "guessed" ? null : value },
      reactivityKeys: catalogKey(saved.game.id),
    });
    if (Exit.isFailure(exit)) setError(failureMessage(exit.cause));
  };
  return (
    <div inert={locked} aria-disabled={locked} className="max-w-xs aria-disabled:opacity-60">
      <ChoiceField
        id="game-language"
        label="Game language"
        value={saved.language ?? "guessed"}
        choices={choices}
        onChoose={change}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
