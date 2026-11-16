import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { gameFiles, Samples } from "@rpgtl/contracts";
import { game, servicesWith } from "../testUtils/state.ts";
import * as StateFolder from "./StateFolder.ts";
import { decodeStateFolder } from "./decodeStateFolder.ts";

const files = gameFiles(game.id);

it.effect(
  "each kind of state file is decoded with its own schema, and other files are left out",
  () =>
    Effect.gen(function* () {
      const folder = yield* StateFolder.StateFolder;
      yield* folder.write(files.samples, Samples, { gameId: game.id, groups: [] });
      yield* folder.writeBytes(`${files.reports}/compare-x.json`, new TextEncoder().encode("{}"));
      const decoded = yield* decodeStateFolder();
      assert.deepStrictEqual(
        decoded.map(({ file, problem }) => [file, problem === undefined]),
        [
          ["games.json", true],
          [files.database, false],
          [files.imageResults, false],
          [`${files.logs}/translation-x.log`, false],
          [files.samples, true],
        ],
      );
    }).pipe(
      Effect.provide(
        servicesWith({
          "games.json": JSON.stringify([game]),
          [files.database]: "not a database",
          [files.catalog]: "{}",
          [files.imageResults]: JSON.stringify({ version: 1, images: { "Map001.png": {} } }),
          [`${files.logs}/translation-x.log`]: '{"type":"end"}\n',
          [`${files.logs}/nwjs.log`]: "not state",
          "notes.txt": "not state",
        }).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
