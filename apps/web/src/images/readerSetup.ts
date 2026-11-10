import type {
  ImageReaderModelPart,
  ImageReaderSetupStatus,
  ImageReaderSetupStep,
  SourceLanguage,
} from "@rpgtl/contracts";
import { megabytes } from "../translation/counts.ts";

/** What the reader runs on, after "runs on". */
export const runsOn: Record<ImageReaderSetupStatus["device"], string> = {
  gpu: "the NVIDIA graphics card",
  directml: "the graphics card, through DirectML",
  cpu: "the processor",
};

const setupSteps: Record<ImageReaderSetupStep, string> = {
  uv: "Downloading uv, which installs the reader's Python",
  packages: "Downloading the reader's Python packages",
  models: "Converting the reader's models",
  cleanup: "Deleting what setting up no longer needs",
};

const modelParts: Record<ImageReaderModelPart, string> = {
  textDetection: "downloading and converting the model that finds text",
  textRecognition: "downloading and converting the model that reads text",
  koreanRecognition: "downloading and converting the model that reads Korean",
  lamaDownload: "downloading LaMa, which erases text",
  lamaCheck: "checking the rebuilt LaMa against the original",
  lamaExport: "converting LaMa",
};

/** How far setting up got, while it runs. */
export type SettingUp = Extract<ImageReaderSetupStatus["phase"], { readonly _tag: "SettingUp" }>;

/** Why the last setting up failed, while nothing runs. */
export const setupFailure = ({ phase }: ImageReaderSetupStatus) =>
  phase._tag === "Idle" ? phase.error : undefined;

/** What setting up does now, with how far its download got. */
export const setupLabel = ({ step, parts, part, downloading }: SettingUp) => {
  const doing =
    step === "models" && part !== undefined
      ? `${setupSteps.models}, ${parts.indexOf(part) + 1} of ${parts.length}: ${modelParts[part]}`
      : setupSteps[step];
  return downloading
    ? `${doing} · ${megabytes(downloading.done)} of ${megabytes(downloading.total)} MB`
    : doing;
};

/**
 * How far the step got in percent, or `null` when nothing tells: downloads by their bytes, and
 * converting the models by its parts, with the current part's download counted in. `working` is
 * true while a part goes on that nothing measures.
 */
export const setupProgress = ({ step, parts, part, downloading }: SettingUp) => {
  const fraction = downloading ? downloading.done / Math.max(downloading.total, 1) : undefined;
  if (step === "models") {
    const index = part === undefined ? 0 : Math.max(0, parts.indexOf(part));
    return {
      value: ((index + (fraction ?? 0)) / Math.max(parts.length, 1)) * 100,
      working: fraction === undefined,
    };
  }
  return { value: fraction === undefined ? null : fraction * 100, working: false };
};

/**
 * Whether the reader can read a game in `language` now: neither setting up nor being removed, and
 * set up, with the Korean recognizer for a Korean game, or started outside RPGTL, which says itself
 * what it lacks.
 */
export const readsLanguage = (reader: ImageReaderSetupStatus, language: SourceLanguage) =>
  reader.phase._tag === "Idle" &&
  (reader.external !== undefined ||
    (reader.ready && (language !== "korean" || reader.korean.ready)));
