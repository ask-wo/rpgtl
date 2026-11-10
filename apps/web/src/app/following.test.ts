import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { expect, test } from "vite-plus/test";
import { following } from "./following.ts";

class Dropped extends Schema.TaggedError<Dropped>()("Dropped", {}) {}
class Gone extends Schema.TaggedError<Gone>()("Gone", {}) {}

test("a dropped connection connects again, and an error it is told to end on ends it", async () => {
  let connections = 0;
  const connect = Stream.suspend((): Stream.Stream<string, Dropped | Gone> => {
    connections += 1;
    return connections === 1
      ? Stream.concat(Stream.make("first"), Stream.fail(new Dropped()))
      : Stream.concat(Stream.make("again"), Stream.fail(new Gone()));
  });
  const exit = await Effect.runPromiseExit(
    following(connect, Schema.is(Gone)).pipe(Stream.runCollect),
  );
  expect(connections).toBe(2);
  expect(exit._tag === "Failure" && String(exit.cause)).toContain("Gone");
});
