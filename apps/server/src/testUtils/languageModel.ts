import type * as AiError from "effect/ai/AiError";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const prompt = [
  { role: "system", content: "Translate." },
  { role: "user", content: "你好" },
] as const;

export const Answer = Schema.Struct({ "1": Schema.String });

export const reasonOf = <A, R>(effect: Effect.Effect<A, AiError.AiError, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.reason));
