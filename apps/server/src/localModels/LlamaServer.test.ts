import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { estimateMemory, readGgufHeader } from "@rpgtl/domain";
import { ggufHeader, testGguf } from "@rpgtl/domain/testUtils/gguf";
import * as Result from "effect/Result";
import { alive, fakeLlamaLib, fakeLlamaServer, type LlamaSetup } from "../testUtils/llama.ts";
import { OnWindows } from "../OnWindows.ts";
import * as LlamaServer from "./LlamaServer.ts";

const endpoint = new URL("http://127.0.0.1:11434");
const GiB = 2 ** 30;

/**
 * Runs `use` with llama-server over the fake library `lib`, an Ollama that shows its model file
 * and records what it was asked to unload, and the free memory `setup` names.
 */
const withLlama = Effect.fn("withLlama")(function* <A, E>(
  lib: { readonly dir: string; readonly file: string },
  setup: LlamaSetup,
  use: (
    llama: LlamaServer.LlamaServer["Service"],
    unloads: ReadonlyArray<string>,
  ) => Effect.Effect<A, E, Scope.Scope>,
) {
  const unloaded: Array<string> = [];
  const llama = yield* LlamaServer.LlamaServer.pipe(
    Effect.provide(fakeLlamaServer(lib, setup, unloaded)),
  );
  return yield* use(llama, unloaded).pipe(
    Effect.provideService(LlamaServer.MemoryLimit, setup.memoryLimit ?? (() => ["env"])),
  );
});

const serving = (llama: LlamaServer.LlamaServer["Service"], log: string, expertLayersInRam = 33) =>
  llama.serve({
    endpoint,
    model: "qwen",
    unload: ["qwen", "names"],
    expertLayersInRam,
    slots: 4,
    numCtx: 4096,
    log,
  });

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("serve", () => {
  it.live(
    "frees Ollama's models, starts llama-server with the experts placed, and stops it with the scope",
    () =>
      run(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const lib = yield* fakeLlamaLib();
          const log = path.join(lib.dir, "logs/llama.log");
          const { pid, unloaded } = yield* withLlama(lib, {}, (llama, unloads) =>
            Effect.scoped(
              Effect.gen(function* () {
                const server = yield* serving(llama, log);
                const record = Option.getOrThrow(yield* lib.record);
                const flag = (name: string) => record.argv[record.argv.indexOf(name) + 1];
                assert.strictEqual(flag("--model"), lib.file);
                assert.strictEqual(flag("--host"), "127.0.0.1");
                assert.strictEqual(flag("--n-cpu-moe"), "33");
                assert.strictEqual(flag("-np"), "4");
                assert.strictEqual(flag("-c"), "16384");
                assert.strictEqual(flag("--chat-template"), "chatml");
                assert.strictEqual(flag("--cache-ram"), "0");
                assert.notInclude(record.argv, "--no-cache-prompt");
                assert.strictEqual(
                  record.GGML_BACKEND_PATH,
                  path.join(lib.dir, "cuda_v13/libggml-cuda.so"),
                );
                assert.strictEqual(server.api.href, `http://127.0.0.1:${flag("--port")}/v1`);
                assert.isTrue(yield* alive(record.pid));
                return { pid: record.pid, unloaded: [...unloads] };
              }),
            ),
          );
          assert.deepStrictEqual(unloaded, ["qwen", "names"]);
          assert.isFalse(yield* alive(pid));
          const written = yield* fs.readFileString(log);
          assert.include(written, "version: fake");
          assert.include(written, "RPGTL estimate for 33 expert layers in RAM");
          assert.include(written, "fake llama-server: listening");
        }),
      ),
  );

  it.live("refuses too many expert layers, too little memory or Windows before starting", () =>
    run(
      Effect.gen(function* () {
        const lib = yield* fakeLlamaLib();
        const refusal = (setup: LlamaSetup, layers = 33) =>
          withLlama(lib, setup, (llama) =>
            Effect.flip(serving(llama, `${lib.dir}/llama.log`, layers)),
          );
        const tooMany = yield* refusal({}, 41);
        assert.isTrue(tooMany._tag === "TooManyExpertLayersError" && tooMany.blockCount === 40);
        const short = (setup: LlamaSetup) =>
          refusal(setup).pipe(
            Effect.map((error) =>
              error._tag === "NotEnoughMemoryError" ? error.short : error._tag,
            ),
          );
        assert.strictEqual(yield* short({ vram: 0 }), "vram");
        assert.strictEqual(yield* short({ ram: GiB }), "noRam");
        const launcher = yield* refusal({ memoryLimit: () => ["no-such-launcher"] });
        assert.isTrue(
          launcher._tag === "LlamaServerMissingError" && launcher.missing === "systemdRun",
        );
        const windows = yield* withLlama(lib, {}, (llama) =>
          Effect.flip(serving(llama, `${lib.dir}/llama.log`)),
        ).pipe(Effect.provideService(OnWindows, true));
        assert.isTrue(windows._tag === "LlamaServerMissingError" && windows.missing === "linux");
        assert.isTrue(Option.isNone(yield* lib.record));
      }),
    ),
  );

  it.live(
    "starts a vision model with its vision part, keeping more expert layers in RAM until VRAM fits",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          // Experts of 300 MB a layer, so each layer moved to RAM frees VRAM that counts.
          const model = {
            ...testGguf(),
            tensors: testGguf().tensors.map((tensor) =>
              tensor.name.includes("_exps") ? { ...tensor, size: 100_000_000 } : tensor,
            ),
          };
          const lib = yield* fakeLlamaLib(model);
          const projector = `${lib.dir}/vision.gguf`;
          yield* fs.writeFile(projector, new Uint8Array(1000));
          const gguf = Result.getOrThrow(
            readGgufHeader(ggufHeader(model).header, ggufHeader(model).fileSize),
          );
          const placement = (expertLayersInRam: number) =>
            Result.getOrThrow(
              estimateMemory(gguf, {
                expertLayersInRam,
                numCtx: 8192,
                slots: 1,
                projectorBytes: 1000,
              }),
            );
          const reading = (llama: LlamaServer.LlamaServer["Service"]) =>
            llama.serve({
              endpoint,
              model: "vision",
              unload: ["vision"],
              expertLayersInRam: 2,
              slots: 1,
              numCtx: 8192,
              log: `${lib.dir}/llama.log`,
              vision: true,
              promptCache: false,
            });
          const argv = yield* withLlama(
            lib,
            { projector, expertCount: 0, ram: 64 * GiB, vram: placement(30).vram },
            (llama) =>
              Effect.scoped(
                reading(llama).pipe(
                  Effect.andThen(lib.record),
                  Effect.map((record) => Option.getOrThrow(record).argv),
                ),
              ),
          );
          const flag = (name: string) => argv[argv.indexOf(name) + 1];
          assert.strictEqual(flag("--mmproj"), projector);
          assert.strictEqual(flag("-np"), "1");
          assert.strictEqual(flag("-c"), "8192");
          assert.strictEqual(flag("--n-cpu-moe"), "30");
          assert.include(argv, "--no-cache-prompt");

          const noVision = yield* withLlama(lib, {}, (llama) => Effect.flip(reading(llama)));
          assert.strictEqual(noVision._tag, "NoVisionError");
          const short = yield* withLlama(lib, { projector, ram: 64 * GiB, vram: 0 }, (llama) =>
            Effect.flip(reading(llama)),
          );
          assert.isTrue(short._tag === "NotEnoughMemoryError" && short.expertLayersInRam === 40);
        }),
      ),
  );

  /** How a server that exits while loading after printing `text` ended. */
  const endedWhileLoading = Effect.fn("endedWhileLoading")(function* (text: string) {
    const lib = yield* fakeLlamaLib();
    yield* lib.flag("exit-while-loading", text);
    const error = yield* withLlama(lib, {}, (llama) =>
      Effect.flip(serving(llama, `${lib.dir}/llama.log`)),
    );
    return error._tag === "LlamaServerEndedError" ? `${error.when} ${error.reason}` : error._tag;
  });

  it.live("tells a server that ran out of VRAM while loading from one that failed otherwise", () =>
    run(
      Effect.gen(function* () {
        assert.strictEqual(
          yield* endedWhileLoading("cudaMalloc failed: out of memory"),
          "loading outOfVram",
        );
        assert.strictEqual(yield* endedWhileLoading("error loading model"), "loading crashed");
      }),
    ),
  );

  it.live(
    "a start that runs out of VRAM while loading tries again with one more expert layer in RAM, up to 4 more",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const lib = yield* fakeLlamaLib();
          const log = `${lib.dir}/llama.log`;
          yield* lib.flag("vram-below", "35");
          const argv = yield* withLlama(lib, { ram: 64 * GiB }, (llama) =>
            Effect.scoped(
              serving(llama, log, 32).pipe(
                Effect.andThen(lib.record),
                Effect.map((record) => Option.getOrThrow(record).argv),
              ),
            ),
          );
          assert.strictEqual(argv[argv.indexOf("--n-cpu-moe") + 1], "35");
          const text = yield* fs.readFileString(log);
          assert.strictEqual(text.match(/^version: fake$/gm)?.length, 1);
          assert.deepStrictEqual(
            [...text.matchAll(/RPGTL estimate for (\d+)/g)].map((match) => match[1]),
            ["32", "33", "34", "35"],
          );
          assert.include(text, "out of memory");

          yield* lib.flag("vram-below", "38");
          const error = yield* withLlama(lib, { ram: 64 * GiB }, (llama) =>
            Effect.flip(serving(llama, log, 32)),
          );
          assert.isTrue(error._tag === "LlamaServerEndedError" && error.reason === "outOfVram");
        }),
      ),
  );

  it.live("stopping a start that waits for the model stops the server", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const lib = yield* fakeLlamaLib();
        yield* lib.flag("loading");
        const started = yield* fs.watch(lib.dir).pipe(
          Stream.filter((event) => event.path.endsWith("record.json")),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* withLlama(lib, {}, (llama) =>
          Effect.gen(function* () {
            const starting = yield* Effect.forkChild(
              Effect.scoped(serving(llama, `${lib.dir}/llama.log`)),
            );
            yield* Fiber.join(started);
            const { pid } = Option.getOrThrow(yield* lib.record);
            assert.isTrue(yield* alive(pid));
            yield* Fiber.interrupt(starting);
            assert.isFalse(yield* alive(pid));
          }),
        );
      }),
    ),
  );

  /** Why a running server says it ended after `end` was done to its process or API. */
  const endedRunning = Effect.fn("endedRunning")(function* (
    end: (pid: number, api: URL) => Effect.Effect<unknown>,
  ) {
    const lib = yield* fakeLlamaLib();
    yield* lib.flag("exit-on-request");
    return yield* withLlama(lib, {}, (llama) =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serving(llama, `${lib.dir}/llama.log`);
          yield* end(Option.getOrThrow(yield* lib.record).pid, server.api);
          // Each look waits up to 2 seconds for the exit; a crash that writes a core dump can
          // take longer on a busy machine.
          const ended = yield* server.ended.pipe(Effect.repeat({ until: Option.isSome }));
          return Option.map(ended, (why) => `${why.when} ${why.reason}`);
        }),
      ),
    );
  });

  it.live(
    "a server that ends during the run says whether its memory limit stopped it or it crashed",
    () =>
      run(
        Effect.gen(function* () {
          assert.deepStrictEqual(
            yield* endedRunning((pid) => Effect.sync(() => process.kill(pid, "SIGKILL"))),
            Option.some("running memoryLimit"),
          );
          // llama.cpp aborts on a CUDA error, which isn't the memory limit.
          assert.deepStrictEqual(
            yield* endedRunning((pid) => Effect.sync(() => process.kill(pid, "SIGABRT"))),
            Option.some("running crashed"),
          );
          assert.deepStrictEqual(
            yield* endedRunning((_, api) =>
              HttpClient.post(new URL("/v1/chat/completions", api)).pipe(
                // The fake exits instead of answering.
                Effect.catchTags({ HttpClientError: () => Effect.void }),
                Effect.provide(FetchHttpClient.layer),
              ),
            ),
            Option.some("running crashed"),
          );
        }),
      ),
  );

  // systemd-run needs a user session, which CI's container lacks.
  const userSession =
    spawnSync("systemd-run", ["--user", "--scope", "--quiet", "true"]).status === 0;

  it.live.skipIf(!userSession)("limits the server's RAM to the free RAM minus 2 GB", () =>
    run(
      Effect.gen(function* () {
        const lib = yield* fakeLlamaLib();
        const memoryMax = yield* withLlama(
          lib,
          { memoryLimit: LlamaServer.MemoryLimit.defaultValue() },
          (llama) =>
            Effect.scoped(
              serving(llama, `${lib.dir}/llama.log`).pipe(
                Effect.andThen(lib.record),
                Effect.map((record) => Option.getOrThrow(record).memoryMax),
              ),
            ),
        );
        assert.strictEqual(memoryMax, String(6 * GiB));
      }),
    ),
  );
});
