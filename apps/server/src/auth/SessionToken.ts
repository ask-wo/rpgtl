import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The token this start of RPGTL put into its page; requests without it come from elsewhere. */
export class SessionToken extends Context.Service<SessionToken, string>()(
  "@rpgtl/server/auth/SessionToken",
) {}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const bytes = yield* random.randomBytes(24);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

export const layer = Layer.effect(SessionToken, make);
