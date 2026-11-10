import type { ImageLine, SourceLanguage } from "@rpgtl/contracts";
import {
  hasText,
  type ImageRead,
  imageStrips,
  LetteringAnswer,
  letteringCrop,
  letteringPrompt,
  linesPrompt,
  qwenImageLines,
  QwenLines,
  secondRead,
  withDoubledLines,
} from "@rpgtl/domain";
import * as LanguageModel from "effect/ai/LanguageModel";
import * as AiError from "effect/ai/AiError";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Prompt from "effect/ai/Prompt";
import * as ImageReader from "./ImageReader.ts";

/**
 * Reads a game image with the image reader: a small one enlarged, and when that finds nothing
 * either, strips of it alone; a larger one at twice its size too, for small lettering on busy
 * artwork.
 */
export const readGameImage = Effect.fn("readGameImage")(function* (
  image: Uint8Array,
  language: SourceLanguage,
) {
  const reader = yield* ImageReader.ImageReader;
  const first = yield* reader.read(image, { language });
  switch (secondRead(first)) {
    case "enlarged": {
      const enlarged = yield* reader.read(image, { language, scale: 4 });
      if (hasText(enlarged)) return enlarged;
      if (hasText(first)) return first;
      for (const crop of imageStrips(first)) {
        const strip = yield* reader.read(image, { language, scale: 4, crop });
        if (hasText(strip)) return strip;
      }
      return first;
    }
    case "doubled":
      return withDoubledLines(first, yield* reader.read(image, { language, scale: 2 }));
    case "none":
      return first;
  }
});

const askAbout = (image: Uint8Array, question: string): Prompt.RawInput => [
  {
    role: "user",
    content: [
      { type: "file", mediaType: "image/png", data: image },
      { type: "text", text: question },
    ],
  },
];

// A llama-server that hangs without ending fails the request instead of stalling the run.
const requestTimeout = Duration.minutes(5);

/** The lines the fallback reader takes for part of a drawing, each asked about in a marked crop. */
export const drawnLines = Effect.fn("drawnLines")(function* (
  image: Uint8Array,
  lines: ReadonlyArray<ImageLine>,
) {
  const reader = yield* ImageReader.ImageReader;
  return yield* Effect.filter(lines, (line) =>
    reader.flatten(image, { crop: letteringCrop(line.box), mark: line.box }).pipe(
      Effect.flatMap((crop) =>
        LanguageModel.generateObject({
          prompt: askAbout(crop, letteringPrompt(line.text)),
          schema: LetteringAnswer,
        }).pipe(Effect.timeout(requestTimeout)),
      ),
      Effect.map((response) => response.value.answer === "drawing"),
    ),
  );
});

/** The fallback reader's lines of the image, with its rough boxes; it is asked twice at most. */
export const fallbackLines = Effect.fn("fallbackLines")(function* (
  image: Uint8Array,
  size: Pick<ImageRead, "width" | "height">,
  language: SourceLanguage,
) {
  const reader = yield* ImageReader.ImageReader;
  const flat = yield* reader.flatten(image);
  const response = yield* LanguageModel.generateObject({
    prompt: askAbout(flat, linesPrompt(language)),
    schema: QwenLines,
  }).pipe(
    Effect.timeout(requestTimeout),
    Effect.retry({
      times: 1,
      while: (error) => AiError.isAiError(error) && error.reason._tag === "StructuredOutputError",
    }),
  );
  return qwenImageLines(response.value, size);
});
