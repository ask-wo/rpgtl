import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { OnWindows } from "../OnWindows.ts";
import * as FolderBrowser from "./FolderBrowser.ts";

it.layer(NodeServices.layer)((test) => {
  test.effect(
    "lists a folder's folders by name, marking games, starting where the typed path points",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        for (const file of ["MZ game/data/System.json", "MV game/www/data/System.json"]) {
          yield* fs.makeDirectory(path.dirname(path.join(dir, file)), { recursive: true });
          yield* fs.writeFileString(path.join(dir, file), "{}");
        }
        yield* fs.makeDirectory(path.join(dir, "game 10"));
        yield* fs.makeDirectory(path.join(dir, "Game 9"));
        yield* fs.writeFileString(path.join(dir, "notes.txt"), "");
        const browser = yield* FolderBrowser.FolderBrowser.pipe(
          Effect.provide(FolderBrowser.layer),
          Effect.provideService(OnWindows, false),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: dir }))),
        );
        const listing = yield* browser.list(dir);
        assert.deepStrictEqual(listing, {
          path: dir,
          parent: path.dirname(dir),
          home: dir,
          roots: ["/"],
          folders: [
            { name: "Game 9", path: path.join(dir, "Game 9"), game: false },
            { name: "game 10", path: path.join(dir, "game 10"), game: false },
            { name: "MV game", path: path.join(dir, "MV game"), game: true },
            { name: "MZ game", path: path.join(dir, "MZ game"), game: true },
          ],
        });
        assert.strictEqual((yield* browser.list(path.join(dir, "notes.txt"))).path, dir);
        assert.strictEqual((yield* browser.list("/nowhere/Game.exe")).path, dir);
        assert.strictEqual((yield* browser.list("")).path, dir);
        assert.isNull((yield* browser.list("/")).parent);
      }),
  );
});
