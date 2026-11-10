import { gameFiles, runEnded } from "@rpgtl/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { Catalog } from "@rpgtl/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SessionToken from "../auth/SessionToken.ts";
import { httpClientAnswering } from "../testUtils/ollama.ts";
import { game, noNwjs, playServices, runServices, servicesWith } from "../testUtils/state.ts";
import * as Ollama from "../localModels/Ollama.ts";
import * as Runs from "../translation/Runs.ts";
import * as Activity from "./Activity.ts";

const catalog: Catalog = {
  version: 1,
  game: { id: game.id, title: game.title, engine: "MV" },
  translate: true,
  entries: [
    {
      id: "hello",
      file: "Map001.json",
      path: ["events", "1", "pages", "0", "list", "0", "parameters", "0"],
      source: "你好",
      translation: {},
    },
  ],
  glossary: [],
};

const services = Activity.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(runServices, playServices)),
  Layer.provideMerge(
    Layer.mergeAll(
      servicesWith({
        "games.json": JSON.stringify([game]),
        [gameFiles(game.id).catalog]: JSON.stringify(catalog),
      }),
      noNwjs,
      Layer.succeed(SessionToken.SessionToken, "test-token"),
    ),
  ),
  // Nothing answers, so the run ends at its first request.
  Layer.provideMerge(Ollama.layer),
  Layer.provideMerge(httpClientAnswering(() => Effect.succeedNone)),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("a game's activity follows a translation run started after it was opened", () =>
  Effect.gen(function* () {
    const activity = yield* Activity.Activity;
    const opened = yield* Deferred.make<void>();
    const following = yield* Stream.unwrap(activity.changes(game.id)).pipe(
      Stream.tap(() => Deferred.succeed(opened, undefined)),
      Stream.takeUntil((now) => now.translation !== null && runEnded(now.translation.phase)),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(opened);
    yield* (yield* Runs.Runs).start(game.id, "translate");
    const seen = yield* Fiber.join(following);
    assert.deepInclude(seen[0], {
      launch: null,
      translation: null,
      images: null,
      importing: null,
    });
    assert.deepInclude(seen.at(-1)?.nwjs, { phase: { _tag: "Missing" } });
    assert.include(seen.at(-1)?.translation, { total: 1 });
  }).pipe(Effect.provide(services)),
);
