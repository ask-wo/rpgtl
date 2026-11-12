import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { game, other, servicesWith, StateDir } from "../testUtils/state.ts";
import * as Games from "./Games.ts";

const servicesOver = (files: Record<string, string>) =>
  servicesWith(files).pipe(Layer.provideMerge(NodeServices.layer));

const savedList = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return JSON.parse(yield* fs.readFileString(path.join(yield* StateDir, "games.json")));
});

it.effect("an empty state folder lists no games, and an unknown game isn't inspected", () =>
  Effect.gen(function* () {
    const games = yield* Games.Games;
    assert.deepStrictEqual(yield* games.list, []);
    const error = yield* Effect.flip(games.get(game.id));
    assert.strictEqual(error._tag, "GameNotInspectedError");
  }).pipe(Effect.provide(servicesOver({}))),
);

it.effect("saving adds a new game at the end and replaces a listed one in place", () =>
  Effect.gen(function* () {
    const games = yield* Games.Games;
    yield* games.save(other);
    const renamed = { ...game, title: "雨 2" };
    yield* games.save(renamed);
    assert.deepStrictEqual(yield* games.list, [renamed, other]);
    assert.deepStrictEqual(yield* savedList, [renamed, other]);
  }).pipe(Effect.provide(servicesOver({ "games.json": JSON.stringify([game]) }))),
);

it.effect("a removed game stays saved for its folder and comes back at the end of the list", () =>
  Effect.gen(function* () {
    const games = yield* Games.Games;
    assert.deepStrictEqual(yield* games.forget(game.id), [other]);
    assert.deepStrictEqual(yield* savedList, [{ ...game, removed: true }, other]);
    assert.deepStrictEqual(yield* games.idAt(game.webRoot), Option.some(game.id));
    yield* games.save(game);
    assert.deepStrictEqual(yield* games.list, [other, game]);
  }).pipe(Effect.provide(servicesOver({ "games.json": JSON.stringify([game, other]) }))),
);

it.effect("holding a game refuses a second hold until the first ends, even when it fails", () =>
  Effect.gen(function* () {
    const games = yield* Games.Games;
    const inner = yield* games.exclusive(
      game.id,
      Effect.flip(games.exclusive(game.id, Effect.void)),
    );
    assert.strictEqual(inner._tag, "GameBusyError");
    yield* games.exclusive(other.id, games.exclusive(game.id, Effect.void));

    assert.strictEqual(
      yield* Effect.flip(games.exclusive(game.id, Effect.fail("stopped"))),
      "stopped",
    );
    yield* games.exclusive(game.id, Effect.void);
  }).pipe(Effect.provide(servicesOver({}))),
);

it.effect("forgetting a game another operation holds leaves the list as it was", () =>
  Effect.gen(function* () {
    const games = yield* Games.Games;
    const error = yield* games.exclusive(game.id, Effect.flip(games.forget(game.id)));
    assert.strictEqual(error._tag, "GameBusyError");
    assert.deepStrictEqual(yield* games.list, [game, other]);
  }).pipe(Effect.provide(servicesOver({ "games.json": JSON.stringify([game, other]) }))),
);
