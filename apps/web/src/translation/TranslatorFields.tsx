import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  type ClaudeChoices,
  type CodexChoices,
  defaultChoices,
  type OllamaChoices,
  type Settings,
} from "@rpgtl/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Button } from "~/components/ui/button";
import { FieldDescription, FieldGroup } from "~/components/ui/field";
import { failureMessage } from "../app/failure.ts";
import { agentModels, ollamaModels } from "./atoms.ts";
import { ChoiceField } from "./ChoiceField.tsx";
import {
  agentModelChoices,
  type Choice,
  claudeEfforts,
  claudeGlossaryEfforts,
  claudeRecommended,
  effortChoices,
  ollamaEfforts,
  privacy,
  samplings,
  translators,
} from "./choices.ts";

type Save = (next: Settings) => void;

/** The settings with `changes` in the choices of `translator`. */
function withChoices(
  settings: Settings,
  translator: "ollama",
  changes: Partial<OllamaChoices>,
): Settings;
function withChoices(
  settings: Settings,
  translator: "claude",
  changes: Partial<ClaudeChoices>,
): Settings;
function withChoices(
  settings: Settings,
  translator: "codex",
  changes: Partial<CodexChoices>,
): Settings;
function withChoices(
  settings: Settings,
  translator: Settings["translation"]["translator"],
  changes: object,
): Settings {
  const { translation } = settings;
  return {
    ...settings,
    translation: { ...translation, [translator]: { ...translation[translator], ...changes } },
  };
}

/** The models Ollama has installed, with `chosen` kept even when it isn't one of them. */
export const modelChoices = (
  installed: ReadonlyArray<string>,
  chosen: string,
): Array<Choice<string>> => [
  ...(chosen && !installed.includes(chosen)
    ? [{ value: chosen, label: `${chosen} (not installed)` }]
    : []),
  ...installed.map((name) => ({ value: name, label: name })),
];

/** The models installed in the chosen Ollama server, and a way to ask it again. */
export const useOllamaModels = (endpoint: string) => {
  const atom = ollamaModels(endpoint);
  return { models: useAtomValue(atom), reload: useAtomRefresh(atom) };
};

/** Which translator runs translate the game and the glossary, with that translator's options. */
export function TranslatorFields({
  settings,
  save,
}: {
  readonly settings: Settings;
  readonly save: Save;
}) {
  const { translator } = settings.translation;
  return (
    <FieldGroup>
      {translator === "ollama" && <OllamaFields settings={settings} save={save} />}
      {translator === "claude" && <ClaudeFields settings={settings} save={save} />}
      {translator === "codex" && <CodexFields settings={settings} save={save} />}
    </FieldGroup>
  );
}

/** The translator choice, with a button that asks it again for its models. */
function TranslatorChoice({
  settings,
  save,
  reload,
  from,
}: {
  readonly settings: Settings;
  readonly save: Save;
  readonly reload: () => void;
  readonly from: string;
}) {
  const { translator } = settings.translation;
  return (
    <div className="flex flex-col gap-2">
      <ChoiceField
        id="translator"
        label="Translator"
        value={translator}
        choices={translators}
        onChoose={(next) =>
          save({ ...settings, translation: { ...settings.translation, translator: next } })
        }
        action={
          <Button variant="outline" title={`Ask ${from} again for its models`} onClick={reload}>
            Reload models
          </Button>
        }
      />
      <FieldDescription>{privacy[translator]}</FieldDescription>
    </div>
  );
}

function OllamaFields({ settings, save }: { readonly settings: Settings; readonly save: Save }) {
  const { endpoint } = settings.ollama;
  const chosen = settings.translation.ollama;
  const choose = (changes: Partial<OllamaChoices>) =>
    save(withChoices(settings, "ollama", changes));
  const { models, reload } = useOllamaModels(endpoint);
  const installed = AsyncResult.getOrElse(models, () => []);
  const note = AsyncResult.isFailure(models)
    ? failureMessage(models.cause)
    : AsyncResult.isSuccess(models) && installed.length === 0
      ? `No models installed. Run: ollama pull ${defaultChoices.ollama.model}`
      : undefined;
  return (
    <>
      <TranslatorChoice settings={settings} save={save} reload={reload} from="Ollama" />
      <div className="grid gap-4 @sm:grid-cols-2">
        <ChoiceField
          id="model"
          label="Model"
          value={chosen.model}
          choices={modelChoices(installed, chosen.model)}
          onChoose={(model) => choose({ model })}
        />
        <ChoiceField
          id="glossary-model"
          label="Glossary model"
          value={chosen.glossaryModel}
          choices={[
            { value: "", label: "Same as Model" },
            ...modelChoices(installed, chosen.glossaryModel),
          ]}
          onChoose={(glossaryModel) => choose({ glossaryModel })}
        />
        <ChoiceField
          id="sampling"
          label="Sampling"
          value={chosen.sampling}
          choices={samplings}
          onChoose={(sampling) => choose({ sampling })}
        />
        <ChoiceField
          id="thinking"
          label="Thinking"
          value={chosen.effort}
          choices={
            settings.ollama.runner === "ollama"
              ? ollamaEfforts
              : ollamaEfforts.map((choice) =>
                  choice.value === "on"
                    ? { ...choice, label: "On (Ollama runner only)", disabled: true }
                    : choice,
                )
          }
          onChoose={(effort) => choose({ effort })}
        />
      </div>
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
    </>
  );
}

/** The models the Claude or Codex CLI lists, a way to ask it again, and why it couldn't. */
const useAgentModels = (translator: "claude" | "codex") => {
  const atom = agentModels(translator);
  const result = useAtomValue(atom);
  return {
    listed: AsyncResult.getOrElse(result, () => []),
    note: AsyncResult.isFailure(result) ? failureMessage(result.cause) : undefined,
    reload: useAtomRefresh(atom),
  };
};

function ClaudeFields({ settings, save }: { readonly settings: Settings; readonly save: Save }) {
  const chosen = settings.translation.claude;
  const choose = (changes: Partial<ClaudeChoices>) =>
    save(withChoices(settings, "claude", changes));
  const { listed, note, reload } = useAgentModels("claude");
  return (
    <>
      <TranslatorChoice settings={settings} save={save} reload={reload} from="Claude Code" />
      <div className="grid gap-4 @sm:grid-cols-2">
        <div className="flex flex-col gap-4">
          <ChoiceField
            id="claude-model"
            label="Model"
            value={chosen.model}
            choices={agentModelChoices(listed, chosen.model, claudeRecommended.model)}
            onChoose={(model) => choose({ model })}
          />
          <ChoiceField
            id="claude-thinking"
            label="Thinking"
            value={chosen.effort}
            choices={effortChoices(
              listed.find((model) => model.id === chosen.model),
              chosen.effort,
              claudeEfforts[chosen.model],
            )}
            onChoose={(effort) => choose({ effort })}
          />
        </div>
        <div className="flex flex-col gap-4">
          <ChoiceField
            id="claude-glossary-model"
            label="Glossary model"
            value={chosen.glossaryModel}
            choices={agentModelChoices(
              listed,
              chosen.glossaryModel,
              claudeRecommended.glossaryModel,
            )}
            onChoose={(glossaryModel) => choose({ glossaryModel })}
          />
          <ChoiceField
            id="claude-glossary-thinking"
            label="Glossary thinking"
            value={chosen.glossaryEffort}
            choices={effortChoices(
              listed.find((model) => model.id === chosen.glossaryModel),
              chosen.glossaryEffort,
              claudeGlossaryEfforts[chosen.glossaryModel],
            )}
            onChoose={(glossaryEffort) => choose({ glossaryEffort })}
          />
        </div>
      </div>
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      <FieldDescription>
        Needs{" "}
        <a href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">
          Claude Code
        </a>{" "}
        installed and signed in once with <code>claude</code> in a terminal.
      </FieldDescription>
    </>
  );
}

function CodexFields({ settings, save }: { readonly settings: Settings; readonly save: Save }) {
  const chosen = settings.translation.codex;
  const choose = (changes: Partial<CodexChoices>) => save(withChoices(settings, "codex", changes));
  const { listed, note, reload } = useAgentModels("codex");
  const fallback = listed.find((model) => model.isDefault);
  const model = chosen.model ? listed.find(({ id }) => id === chosen.model) : fallback;
  return (
    <>
      <TranslatorChoice settings={settings} save={save} reload={reload} from="Codex" />
      <div className="grid gap-4 @sm:grid-cols-2">
        <div className="flex flex-col gap-4">
          <ChoiceField
            id="codex-model"
            label="Model"
            value={chosen.model}
            choices={[
              {
                value: "",
                label: fallback ? `Codex's default (${fallback.name})` : "Codex's default",
              },
              ...agentModelChoices(listed, chosen.model),
            ]}
            onChoose={(next) => choose({ model: next })}
          />
          <ChoiceField
            id="codex-thinking"
            label="Thinking"
            value={chosen.effort}
            choices={effortChoices(model, chosen.effort)}
            onChoose={(effort) => choose({ effort })}
          />
        </div>
        <div className="flex flex-col gap-4">
          <ChoiceField
            id="codex-glossary-model"
            label="Glossary model"
            value={chosen.glossaryModel}
            choices={[
              { value: "", label: "Same as Model" },
              ...agentModelChoices(listed, chosen.glossaryModel),
            ]}
            onChoose={(glossaryModel) => choose({ glossaryModel })}
          />
          <ChoiceField
            id="codex-glossary-thinking"
            label="Glossary thinking"
            value={chosen.glossaryEffort}
            choices={effortChoices(
              chosen.glossaryModel ? listed.find(({ id }) => id === chosen.glossaryModel) : model,
              chosen.glossaryEffort,
            )}
            onChoose={(glossaryEffort) => choose({ glossaryEffort })}
          />
        </div>
      </div>
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      <FieldDescription>
        Needs the{" "}
        <a href="https://developers.openai.com/codex/cli" target="_blank" rel="noreferrer">
          Codex CLI
        </a>{" "}
        installed, and a login of its own, apart from the Codex app's: run{" "}
        <code>rpgtl codex login</code> once (<code>pnpm run codex login</code> in a checkout).
      </FieldDescription>
    </>
  );
}
