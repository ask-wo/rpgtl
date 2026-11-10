import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Settings as SettingsSchema } from "@rpgtl/contracts";
import * as Settings from "./Settings.ts";

/** Settings in a new config folder; `run` gets a fresh `Settings` each time, as a restart would. */
const withConfigFolder = Effect.fn("withConfigFolder")(
  function* <A, E>(
    run: (
      settings: Effect.Effect<Settings.Settings["Service"]>,
      file: string,
    ) => Effect.Effect<A, E>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const layer = Settings.layer.pipe(
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_CONFIG_HOME: dir, HOME: dir })),
      ),
      Layer.provide(NodeServices.layer),
    );
    const settings = Effect.service(Settings.Settings).pipe(Effect.provide(layer), Effect.orDie);
    return yield* run(settings, path.join(dir, "rpgtl", "settings.json"));
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

it.effect(
  "without a file every setting has its default, and saved settings come back after a restart",
  () =>
    withConfigFolder((settings) =>
      Effect.gen(function* () {
        const first = yield* settings;
        const defaults = yield* first.get;
        assert.deepStrictEqual(defaults, yield* Schema.decodeEffect(SettingsSchema)({}));
        const saved = {
          ...defaults,
          sharpPixels: true,
          ollama: { ...defaults.ollama, runner: "llama-server" as const, minExpertLayersInRam: 33 },
        };
        yield* first.save(saved);
        assert.deepStrictEqual(yield* (yield* settings).get, saved);
      }),
    ),
);

it.effect("a settings file that doesn't decode is an error naming it", () =>
  withConfigFolder((settings, file) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, JSON.stringify({ ollama: { runner: "vllm" } }));
      const error = yield* Effect.flip((yield* settings).get);
      assert.strictEqual(error.file, file);
      assert.strictEqual(error.operation, "read");
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
