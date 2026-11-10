import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import os from "node:os";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

export class FreeMemoryError extends Schema.TaggedError<FreeMemoryError>()("FreeMemoryError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Could not read the free VRAM from nvidia-smi.";
  }
}

/** The nvidia-smi that reads the free VRAM; tests point it at a fake. */
export const NvidiaSmi = Context.Reference<string>("@rpgtl/server/localModels/NvidiaSmi", {
  defaultValue: () => "nvidia-smi",
});

/** How much memory programs could take now, in bytes. */
export class FreeMemory extends Context.Service<
  FreeMemory,
  {
    /** The RAM the system could give programs without swapping (`MemAvailable` on Linux). */
    readonly ram: Effect.Effect<number>;
    /** The free VRAM of the first GPU. */
    readonly vram: Effect.Effect<number, FreeMemoryError>;
  }
>()("@rpgtl/server/localModels/FreeMemory") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nvidiaSmi = yield* NvidiaSmi;

  const ram = Effect.sync(() => os.freemem()).pipe(Effect.withSpan("FreeMemory.ram"));

  const vram = spawner
    .string(
      ChildProcess.make(nvidiaSmi, ["--query-gpu=memory.free", "--format=csv,noheader,nounits"]),
    )
    .pipe(
      Effect.flatMap((output) => {
        // MiB per GPU, one line each; a failing nvidia-smi prints its error instead.
        const first = output.trim().split("\n")[0]?.trim() ?? "";
        return /^\d+(?:\.\d+)?$/.test(first)
          ? Effect.succeed(Number(first) * 2 ** 20)
          : Effect.fail(new FreeMemoryError({ cause: output }));
      }),
      Effect.catchTags({
        PlatformError: (cause) => Effect.fail(new FreeMemoryError({ cause })),
      }),
      Effect.withSpan("FreeMemory.vram"),
    );

  return FreeMemory.of({ ram, vram });
});

export const layer = Layer.effect(FreeMemory, make);
