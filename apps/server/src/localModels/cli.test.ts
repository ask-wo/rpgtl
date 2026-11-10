import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as TestConsole from "effect/testing/TestConsole";
import { alive, fakeLlamaLib, fakeLlamaServer } from "../testUtils/llama.ts";
import { servicesWith } from "../testUtils/state.ts";
import { llamaServer } from "./cli.ts";
import * as LlamaServer from "./LlamaServer.ts";

it.live("the llama-server command prints its address and stops the server when interrupted", () =>
  Effect.gen(function* () {
    const lib = yield* fakeLlamaLib();
    const command = Command.runWith(llamaServer, { version: "test" })([
      "--model",
      "qwen",
      "--experts",
      "33",
    ]).pipe(
      Effect.provide(Layer.mergeAll(fakeLlamaServer(lib, {}), servicesWith({}))),
      Effect.provideService(LlamaServer.MemoryLimit, () => ["env"]),
    );
    const fiber = yield* Effect.forkChild(command);
    // The fake writes its record once it has started; serving waits until it answers.
    const record = yield* lib.record.pipe(
      Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced("50 millis") }),
      Effect.map(Option.getOrThrow),
    );
    const printed = yield* TestConsole.logLines.pipe(
      Effect.repeat({ until: (lines) => lines.length > 0, schedule: Schedule.spaced("50 millis") }),
    );
    assert.match(String(printed[0]), /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.isTrue(yield* alive(record.pid));
    yield* Fiber.interrupt(fiber);
    assert.isFalse(yield* alive(record.pid));
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, TestConsole.layer))),
);
