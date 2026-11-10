import { useAtomValue } from "@effect/atom-react";
import type { Settings } from "@rpgtl/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useState } from "react";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { llamaServer, modelInfo } from "./atoms.ts";
import { ChoiceField } from "./ChoiceField.tsx";
import { qwenExpertHints, runners } from "./choices.ts";

type Save = (next: Settings) => void;

/**
 * Where the local models run, which the translation model and the backup reader share: the Ollama
 * server, and whether its models run in Ollama or in its bundled llama-server.
 */
export function LocalModelFields({
  settings,
  save,
}: {
  readonly settings: Settings;
  readonly save: Save;
}) {
  const { ollama } = settings;
  const choose = (changes: Partial<Settings["ollama"]>) =>
    save({ ...settings, ollama: { ...ollama, ...changes } });
  const server = useAtomValue(llamaServer);
  // Until the server answers, llama-server stays choosable rather than flashing as unavailable.
  const unavailable = AsyncResult.isSuccess(server) ? server.value.unavailable : undefined;
  const choices = runners.map((choice) =>
    choice.value === "llama-server" && unavailable !== undefined
      ? { ...choice, label: "llama-server (not available here)", disabled: true }
      : choice,
  );
  return (
    <FieldGroup>
      <EndpointField
        key={ollama.endpoint}
        endpoint={ollama.endpoint}
        onChange={(endpoint) => choose({ endpoint })}
      />
      <div className="grid gap-4 @sm:grid-cols-2">
        <ChoiceField
          id="runner"
          label="Runs in"
          value={ollama.runner}
          choices={choices}
          onChoose={(runner) => choose({ runner })}
        />
        {ollama.runner === "llama-server" && (
          <ExpertLayersField settings={settings} choose={choose} />
        )}
      </div>
      <FieldDescription>
        {unavailable ??
          (ollama.runner === "llama-server"
            ? "Usually faster than Ollama, since it's less strict about settings such as how much free memory a model needs."
            : "Usually slower than llama-server, which is less strict about settings such as how much free memory a model needs.")}
      </FieldDescription>
    </FieldGroup>
  );
}

function EndpointField({
  endpoint,
  onChange,
}: {
  readonly endpoint: string;
  readonly onChange: (endpoint: string) => void;
}) {
  const [text, setText] = useState(endpoint);
  return (
    <Field>
      <FieldLabel htmlFor="ollama-endpoint">Ollama endpoint</FieldLabel>
      <Input
        id="ollama-endpoint"
        type="url"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const next = text.trim();
          if (!next) setText(endpoint);
          else if (next !== endpoint) onChange(next);
        }}
      />
    </Field>
  );
}

/** The layer count of the model, once Ollama answered. */
const useBlockCount = (endpoint: string, model: string) => {
  const info = useAtomValue(modelInfo(endpoint, model));
  return AsyncResult.isSuccess(info) ? info.value.blockCount : 0;
};

/**
 * The least expert layers llama-server keeps in system RAM, up to the larger layer count of the
 * local models in use; it keeps more until the rest fits on the graphics card.
 */
function ExpertLayersField({
  settings,
  choose,
}: {
  readonly settings: Settings;
  readonly choose: (changes: Partial<Settings["ollama"]>) => void;
}) {
  const { endpoint, minExpertLayersInRam } = settings.ollama;
  const translating = settings.translation.translator === "ollama";
  const translationModel = translating ? settings.translation.ollama.model : "";
  const imageModel = settings.images.model;
  // The section shows only while one of the two is set, so each count asks about a model.
  const blockCount = Math.max(
    useBlockCount(endpoint, translationModel || imageModel),
    useBlockCount(endpoint, imageModel || translationModel),
    minExpertLayersInRam,
  );
  const qwen = [translationModel, imageModel].some((model) => /qwen3\.6/i.test(model));
  const layers = Array.from({ length: blockCount }, (_, index) => blockCount - index);
  return (
    <ChoiceField
      id="expert-layers"
      label="Expert layers in system RAM"
      value={minExpertLayersInRam}
      choices={[
        { value: 0, label: "Automatic (as few as fit)" },
        ...layers.map((count) => {
          const hint = qwen ? qwenExpertHints[count] : undefined;
          return { value: count, label: `At least ${count}${hint ? ` · ${hint}` : ""}` };
        }),
      ]}
      onChoose={(count) => choose({ minExpertLayersInRam: count })}
    />
  );
}
