import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as StateFolder from "./StateFolder.ts";

/** A state folder in a new temporary folder whose renames fail with `failures`, one per try. */
const folderWithRenames = Effect.fn("folderWithRenames")(function* (
  failures: ReadonlyArray<PlatformError.SystemErrorTag>,
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped();
  let calls = 0;
  const rename: FileSystem.FileSystem["rename"] = (from, to) =>
    Effect.suspend(() => {
      const failure = failures[calls++];
      return failure === undefined
        ? fs.rename(from, to)
        : Effect.fail(
            PlatformError.systemError({ _tag: failure, module: "test", method: "rename" }),
          );
    });
  const folder = yield* StateFolder.make(dir).pipe(
    Effect.provideService(FileSystem.FileSystem, { ...fs, rename }),
  );
  return { folder, files: () => fs.readDirectory(dir) };
});

it.live("a write waits out a file another program holds open for a moment", () =>
  Effect.gen(function* () {
    const { folder, files } = yield* folderWithRenames(["PermissionDenied", "Busy"]);
    yield* folder.write("catalog.json", Schema.String, "saved");
    assert.deepStrictEqual(yield* folder.read("catalog.json", Schema.String), Option.some("saved"));
    assert.deepStrictEqual(yield* files(), ["catalog.json"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a write that fails leaves no temporary file behind", () =>
  Effect.gen(function* () {
    const { folder, files } = yield* folderWithRenames(["NotFound"]);
    const error = yield* Effect.flip(folder.write("catalog.json", Schema.String, "lost"));
    assert.strictEqual(error.operation, "write");
    assert.deepStrictEqual(yield* files(), []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("RPGTL_DIR may start with ~ for the home folder, as .env has no shell to expand it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* Effect.gen(function* () {
      const folder = yield* StateFolder.StateFolder;
      yield* folder.write("games.json", Schema.String, "saved");
    }).pipe(
      Effect.provide(
        StateFolder.layer.pipe(
          Layer.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ RPGTL_DIR: "~/state", HOME: home })),
          ),
        ),
      ),
    );
    assert.isTrue(yield* fs.exists(`${home}/state/games.json`));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
