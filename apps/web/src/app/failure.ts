import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

/**
 * What to tell the user about a failed request. Every error the API declares carries a message
 * meant for the page; anything else means the server didn't answer as it should.
 */
export const failureMessage = (cause: Cause.Cause<{ readonly message: string }>) =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: (error) => error.message,
    onNone: () =>
      Cause.hasInterruptsOnly(cause)
        ? "Stopped."
        : "RPGTL didn't answer as expected. Is it still running? Its log says more.",
  });
