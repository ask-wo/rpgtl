import { RequestRefused } from "@rpgtl/contracts";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const isRequestRefused = Schema.is(RequestRefused);

/**
 * Follows a stream of Server-Sent Events across dropped connections, so an atom of it holds the
 * last value it heard. A refused request ends it: after a restart RPGTL has a new token, and only
 * reloading the page gets it. So does an error `ends` picks, such as a game that isn't inspected.
 */
export const following = <A, E, R, Ends = never>(
  stream: Stream.Stream<A, E | RequestRefused, R>,
  ends?: (error: unknown) => error is Ends,
): Stream.Stream<A, RequestRefused | Ends, R> =>
  stream.pipe(
    Stream.catchIf(isRequestRefused, Stream.fail, (error) =>
      ends?.(error) ? Stream.fail(error) : Stream.empty,
    ),
    Stream.repeat(Schedule.spaced("1 second")),
  );
