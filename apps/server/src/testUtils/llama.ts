import { ggufHeader, type TestGguf, testGguf } from "@rpgtl/domain/testUtils/gguf";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as FreeMemory from "../localModels/FreeMemory.ts";
import * as LlamaServer from "../localModels/LlamaServer.ts";
import { ollamaAnswering } from "./ollama.ts";

const Record = Schema.fromJsonString(
  Schema.Struct({
    argv: Schema.Array(Schema.String),
    pid: Schema.Int,
    LD_LIBRARY_PATH: Schema.String,
    GGML_BACKEND_PATH: Schema.String,
    memoryMax: Schema.NullOr(Schema.String),
  }),
);

/**
 * A folder laid out like Ollama's library, with the fake in `fakeLlamaServer.ts` as its
 * llama-server and an empty CUDA library, and a sparse GGUF file of `model`. Removed with the scope.
 */
export const fakeLlamaLib = Effect.fn("fakeLlamaLib")(function* (model: TestGguf = testGguf()) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  const script = path.join(dir, "llama-server");
  yield* fs.writeFileString(
    script,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(import.meta.dirname, "fakeLlamaServer.ts"))} "$0" "$@"\n`,
  );
  yield* fs.chmod(script, 0o755);
  yield* fs.makeDirectory(path.join(dir, "cuda_v12"));
  yield* fs.makeDirectory(path.join(dir, "cuda_v13"));
  yield* fs.writeFileString(path.join(dir, "cuda_v12/libggml-cuda.so"), "");
  yield* fs.writeFileString(path.join(dir, "cuda_v13/libggml-cuda.so"), "");
  const file = path.join(dir, "model.gguf");
  const { header, fileSize } = ggufHeader(model);
  yield* fs.writeFile(file, header);
  yield* fs.truncate(file, fileSize);
  return {
    dir,
    file,
    /** What the fake started with, once it has started. */
    record: fs
      .readFileString(path.join(dir, "record.json"))
      .pipe(
        Effect.flatMap(Schema.decodeEffect(Record)),
        Effect.asSome,
        Effect.catchTags({ PlatformError: () => Effect.succeedNone }),
      ),
    flag: (name: string, text = "") => fs.writeFileString(path.join(dir, name), text),
  };
});

/** Whether the process is still running; signal 0 only checks that it exists. */
export const alive = (pid: number) =>
  Effect.try({ try: () => process.kill(pid, 0), catch: () => "not running" }).pipe(
    Effect.isSuccess,
  );

const GiB = 2 ** 30;

/** The model and computer a fake llama-server runs on. */
export interface LlamaSetup {
  readonly expertCount?: number;
  /** The model's vision part, which Ollama names in a second FROM line. */
  readonly projector?: string;
  readonly ram?: number;
  readonly vram?: number;
  /** Prefix of the server's command; the default starts it without a memory limit. */
  readonly memoryLimit?: (bytes: number) => ReadonlyArray<string>;
}

/**
 * llama-server over the fake library `lib`, with an Ollama that shows its model file and pushes
 * the models it is asked to unload into `unloaded`, and the free memory `setup` names.
 */
export const fakeLlamaServer = (
  lib: { readonly dir: string; readonly file: string },
  setup: LlamaSetup,
  unloaded: Array<string> = [],
) =>
  LlamaServer.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ollamaAnswering((url, body) =>
          Effect.sync(() => {
            if (url.pathname === "/api/show")
              return Option.some(
                Response.json({
                  modelfile: `FROM ${lib.file}\n${setup.projector ? `FROM ${setup.projector}\n` : ""}TEMPLATE x\n`,
                  model_info: {
                    "test.block_count": 40,
                    "test.expert_count": setup.expertCount ?? 8,
                  },
                }),
              );
            if (url.pathname === "/api/generate") {
              if (
                typeof body === "object" &&
                body &&
                "model" in body &&
                typeof body.model === "string"
              )
                unloaded.push(body.model);
              return Option.some(Response.json({}));
            }
            return Option.some(Response.json({ models: [] }));
          }),
        ),
        Layer.succeed(
          FreeMemory.FreeMemory,
          FreeMemory.FreeMemory.of({
            ram: Effect.succeed(setup.ram ?? 8 * GiB),
            vram: Effect.succeed(setup.vram ?? 8 * GiB),
          }),
        ),
        FetchHttpClient.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown({ RPGTL_OLLAMA_LIB: lib.dir })),
      ),
    ),
  );
