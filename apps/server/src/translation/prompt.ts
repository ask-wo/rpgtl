import * as AiError from "effect/ai/AiError";
import type * as Prompt from "effect/ai/Prompt";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Stream from "effect/Stream";

export interface TextMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  /** The message's images in base64, as Ollama takes them. */
  readonly images?: ReadonlyArray<string>;
}

/**
 * The prompt as plain text messages. Translators take only text: files and tool results are an
 * error, and an earlier answer's reasoning is left out. With `images`, image files given as bytes
 * or base64 go into the message's `images`.
 */
export const textMessages = (
  module: string,
  prompt: Prompt.Prompt,
  options?: { readonly images: true },
) =>
  Effect.forEach(prompt.content, (message) => {
    if (message.role === "system")
      return Effect.succeed<TextMessage>({ role: "system", content: message.content });
    if (message.role === "tool")
      return Effect.fail(
        AiError.make({
          module,
          method: "generateText",
          reason: new AiError.InvalidUserInputError({ description: "Translators use no tools." }),
        }),
      );
    const text: Array<string> = [];
    const images: Array<string> = [];
    for (const part of message.content) {
      if (part.type === "text") text.push(part.text);
      else if (
        options?.images &&
        part.type === "file" &&
        part.mediaType.startsWith("image/") &&
        !(part.data instanceof URL)
      )
        images.push(typeof part.data === "string" ? part.data : Base64.encode(part.data));
      else if (part.type !== "reasoning")
        return Effect.fail(
          AiError.make({
            module,
            method: "generateText",
            reason: new AiError.InvalidUserInputError({
              description: `Translators take only text, not a ${part.type} part.`,
            }),
          }),
        );
    }
    return Effect.succeed<TextMessage>({
      role: message.role,
      content: text.join(""),
      ...(images.length > 0 && { images }),
    });
  });

/**
 * Turns the messages into one prompt, since the Claude and Codex CLIs take no earlier assistant
 * turns: system messages become the system prompt and later turns follow the first user message.
 */
export function agentPrompt(messages: ReadonlyArray<TextMessage>) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const [first, ...rest] = messages.filter((message) => message.role !== "system");
  const prompt = [
    first?.content ?? "",
    ...rest.map((message) =>
      message.role === "assistant" ? `Your answer was:\n${message.content}` : message.content,
    ),
  ].join("\n\n");
  return { system, prompt };
}

/** The answer without the Markdown code fence agents put around JSON. */
export const withoutFence = (content: string) =>
  content.replace(/^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/, "$1");

/** `streamText` for a translator, which never streams. */
export const noStreaming = (module: string) => () =>
  Stream.fail(
    AiError.make({
      module,
      method: "generateText",
      reason: new AiError.InvalidUserInputError({ description: "RPGTL doesn't stream answers." }),
    }),
  );
