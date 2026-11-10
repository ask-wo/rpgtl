import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { Settings } from "@rpgtl/contracts";
import { FieldDescription, FieldGroup } from "~/components/ui/field";
import { ChoiceField } from "./ChoiceField.tsx";
import { faintChoices } from "./choices.ts";
import { modelChoices, useOllamaModels } from "./TranslatorFields.tsx";

/** What image translation does with images it reads only partly, and with faint text. */
export function ImageReadingFields({
  settings,
  save,
}: {
  readonly settings: Settings;
  readonly save: (next: Settings) => void;
}) {
  const { models } = useOllamaModels(settings.ollama.endpoint);
  const installed = AsyncResult.getOrElse(models, () => []);
  const { images } = settings;
  const choose = (changes: Partial<Settings["images"]>) =>
    save({ ...settings, images: { ...images, ...changes } });
  return (
    <FieldGroup>
      <div className="grid gap-4 @sm:grid-cols-2">
        <ChoiceField
          id="image-model"
          label="Backup reader"
          value={images.model}
          choices={[
            { value: "", label: "None" },
            // The reading prompts ask for Qwen's boxes, from 0 to 1000 across the image.
            ...modelChoices(installed, images.model).map((choice) =>
              /qwen3\.6/i.test(choice.value)
                ? { ...choice, label: `${choice.label} (recommended)` }
                : choice,
            ),
          ]}
          onChoose={(model) => choose({ model })}
        />
        <ChoiceField
          id="image-faint"
          label="Faint text"
          value={images.includeFaint ? "include" : "skip"}
          choices={faintChoices}
          onChoose={(faint) => choose({ includeFaint: faint === "include" })}
        />
      </div>
      <FieldDescription>
        Text is read with PaddleOCR and erased with LaMa. The backup reader then retries flagged
        images.
      </FieldDescription>
    </FieldGroup>
  );
}
