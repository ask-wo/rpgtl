import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { folderWith, mvGame } from "../testUtils/gameFolder.ts";
import { opened, servicesWith, typed } from "../testUtils/state.ts";
import { appliedCatalogs } from "./appliedCatalogs.ts";
import * as Catalogs from "./Catalogs.ts";

it.effect("a catalog that no longer applies to its game's files names the files", () =>
  Effect.gen(function* () {
    const catalogs = yield* Catalogs.Catalogs;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { game } = yield* opened(catalogs.inspect(yield* folderWith(mvGame)));
    yield* typed(game.id, () => "Hi");
    assert.deepStrictEqual(
      (yield* appliedCatalogs()).map(({ problem }) => problem),
      [undefined],
    );
    const map = path.join(game.webRoot, "data", "Map001.json");
    yield* fs.writeFileString(map, (yield* fs.readFileString(map)).replace("你好", "再见"));
    assert.deepStrictEqual(
      (yield* appliedCatalogs()).map(({ problem }) => problem),
      ["no longer holds an entry's source: Map001.json"],
    );
  }).pipe(Effect.provide(servicesWith({}).pipe(Layer.provideMerge(NodeServices.layer)))),
);
