// oxlint-disable effecttsgo/strict-effect-provide -- a command-line entry point
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Nwjs from "./nwjs/Nwjs.ts";

/** Downloads the NW.js Play uses, as the page's download does, so CI can fetch it ahead of the tests. */
Effect.gen(function* () {
  const nwjs = yield* Nwjs.Nwjs;
  yield* nwjs.download;
  const last = Option.getOrUndefined(
    yield* nwjs.changes.pipe(
      Stream.filter((status) => status.phase._tag !== "Downloading"),
      Stream.runHead,
    ),
  );
  if (last?.phase._tag === "Ready") return;
  yield* Console.error(
    (last?.phase._tag === "Missing" && last.phase.error) || "The NW.js download stopped.",
  );
  yield* Effect.sync(() => {
    process.exitCode = 1;
  });
}).pipe(
  Effect.provide(
    Nwjs.layer.pipe(Layer.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer))),
  ),
  NodeRuntime.runMain,
);
