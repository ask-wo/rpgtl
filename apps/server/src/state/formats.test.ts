import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Settings from "../settings/Settings.ts";
import { decodeStateFolder } from "./decodeStateFolder.ts";
import * as StateFolder from "./StateFolder.ts";

const formats = new URL("formats", import.meta.url).pathname;

it.effect("the files each format saved still read once upgraded", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const format of yield* fs.readDirectory(formats)) {
      const dir = yield* fs.makeTempDirectoryScoped();
      yield* fs.copy(path.join(formats, format), dir);
      const decoded = yield* decodeStateFolder().pipe(
        Effect.provide(StateFolder.layerAt(path.join(dir, "state"))),
      );
      assert.deepStrictEqual(
        decoded.filter((file) => file.problem !== undefined),
        [],
        `format ${format}`,
      );
      assert.isAbove(decoded.length, 2, `format ${format}`);
      yield* fs.makeDirectory(path.join(dir, "xdg"));
      yield* fs.rename(path.join(dir, "config"), path.join(dir, "xdg", "rpgtl"));
      const settings = yield* Effect.flatMap(Settings.Settings, (saved) => saved.get).pipe(
        Effect.provide(
          Settings.layer.pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ XDG_CONFIG_HOME: path.join(dir, "xdg") }),
              ),
            ),
          ),
        ),
      );
      assert.isTrue(settings.sharpPixels, `format ${format}`);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
