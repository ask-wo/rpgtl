import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as FreeMemory from "./FreeMemory.ts";

/** Free memory, with VRAM read from an nvidia-smi script with this text. */
const reading = Effect.fn("reading")(
  function* <A, E>(
    nvidiaSmi: string,
    use: (memory: FreeMemory.FreeMemory["Service"]) => Effect.Effect<A, E>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const script = path.join(yield* fs.makeTempDirectoryScoped(), "nvidia-smi");
    yield* fs.writeFileString(script, `#!/bin/sh\n${nvidiaSmi}\n`);
    yield* fs.chmod(script, 0o755);
    const memory = yield* FreeMemory.FreeMemory.pipe(
      Effect.provide(FreeMemory.layer),
      Effect.provideService(FreeMemory.NvidiaSmi, script),
    );
    return yield* use(memory);
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

it.live("reads the free RAM and the first GPU's free VRAM", () =>
  reading("printf '8192\\n4096\\n'", (memory) =>
    Effect.gen(function* () {
      assert.isAbove(yield* memory.ram, 0);
      assert.strictEqual(yield* memory.vram, 8192 * 2 ** 20);
    }),
  ),
);

it.live("fails when nvidia-smi gives no free VRAM", () =>
  reading("echo 'NVIDIA-SMI has failed' >&2; exit 9", (memory) =>
    Effect.gen(function* () {
      assert.strictEqual((yield* Effect.flip(memory.vram))._tag, "FreeMemoryError");
    }),
  ),
);
