import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Catalogs from "../games/Catalogs.ts";
import { folderWith, mvGame } from "../testUtils/gameFolder.ts";
import { opened, servicesWith } from "../testUtils/state.ts";
import * as Playtime from "./Playtime.ts";

const services = Playtime.layer.pipe(
  Layer.provideMerge(servicesWith({})),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("playtime adds up what the game reports and keeps when it was last played", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const playtime = yield* Playtime.Playtime;
    const { game } = yield* opened(catalogs.inspect(yield* folderWith(mvGame)));
    assert.isTrue(Option.isNone(yield* playtime.get(game.id)));
    yield* playtime.add(game.id, 30);
    yield* TestClock.adjust("1 hour");
    yield* Effect.all([playtime.add(game.id, 30), playtime.add(game.id, 12)], {
      concurrency: "unbounded",
    });
    assert.deepStrictEqual(
      yield* playtime.get(game.id),
      Option.some({ seconds: 72, lastPlayed: "1970-01-01T01:00:00.000Z" }),
    );
  }).pipe(Effect.provide(services)),
);

it.effect("playtime refuses a game that isn't in the list", () =>
  Effect.gen(function* () {
    const playtime = yield* Playtime.Playtime;
    const error = yield* Effect.flip(playtime.add("../../elsewhere", 30));
    assert.strictEqual(error._tag, "GameNotInspectedError");
  }).pipe(Effect.provide(services)),
);
