import {
  type EstimateProblem,
  estimateMemory,
  fittedEstimate,
  type MemoryEstimate,
  ramReserve,
  readGgufHeader,
  shortage,
} from "@rpgtl/domain";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Ollama from "./Ollama.ts";
import { freePort } from "../freePort.ts";
import { OnWindows } from "../OnWindows.ts";
import * as FreeMemory from "./FreeMemory.ts";

const gigabytes = (bytes: number) => (bytes / 1_000_000_000).toFixed(1);

export class NoVisionError extends Schema.TaggedError<NoVisionError>()("NoVisionError", {
  model: Schema.String,
}) {
  override get message() {
    return `${this.model} can't read images.`;
  }
}

class TooManyExpertLayersError extends Schema.TaggedError<TooManyExpertLayersError>()(
  "TooManyExpertLayersError",
  { model: Schema.String, blockCount: Schema.Int },
) {
  override get message() {
    return `${this.model} has ${this.blockCount} layers, so at most ${this.blockCount} can keep their experts in system RAM.`;
  }
}

/** Ollama's bundled llama-server, its CUDA library, systemd-run or Linux, which RPGTL needs to run it. */
class LlamaServerMissingError extends Schema.TaggedError<LlamaServerMissingError>()(
  "LlamaServerMissingError",
  {
    missing: Schema.Literals(["llamaServer", "cuda", "systemdRun", "linux"]),
    places: Schema.String,
  },
) {
  override get message() {
    const messages: Record<typeof this.missing, string> = {
      llamaServer: `Ollama's bundled llama-server was not found in ${this.places}.`,
      cuda: `${this.places} has no CUDA library for llama-server (cuda_v*/libggml-cuda.so), so it would run on the CPU.`,
      systemdRun: "Running llama-server under a memory limit needs systemd-run.",
      linux: "RPGTL starts Ollama's bundled llama-server on Linux only.",
    };
    return messages[this.missing];
  }
}

/** A model file whose GGUF header can't be read or lacks what the memory estimate needs. */
class ModelFileError extends Schema.TaggedError<ModelFileError>()("ModelFileError", {
  file: Schema.String,
  problem: Schema.Literals([
    "unreadable",
    "notGguf",
    "endsEarly",
    "unsupported",
    "invalid",
    "architecture",
    "blockCount",
    "attention",
  ]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message() {
    const problems: Record<typeof this.problem, string> = {
      unreadable: "can't be read",
      notGguf: "isn't a GGUF model",
      endsEarly: "is cut off",
      unsupported: "holds metadata RPGTL can't read",
      invalid: "is damaged",
      architecture: "lacks what the memory estimate needs (its architecture)",
      blockCount: "lacks what the memory estimate needs (its layer count)",
      attention: "lacks what the memory estimate needs (its attention layout)",
    };
    return `The model file ${this.file} ${problems[this.problem]}.`;
  }
}

/** How many more expert layers a start that runs out of VRAM while loading moves to RAM. */
const vramRetries = 4;

/** Less free RAM or VRAM than llama-server would need for the placement. */
export class NotEnoughMemoryError extends Schema.TaggedError<NotEnoughMemoryError>()(
  "NotEnoughMemoryError",
  {
    short: Schema.Literals(["ram", "vram", "both", "noRam"]),
    /** The layers the placement keeps in RAM, after fitting the rest into free VRAM. */
    expertLayersInRam: Schema.Int,
    needs: Schema.Struct({ ram: Schema.Finite, vram: Schema.Finite }),
    free: Schema.Struct({ ramLimit: Schema.Finite, vram: Schema.Finite }),
  },
) {
  override get message() {
    const layers = this.expertLayersInRam;
    const { needs, free } = this;
    if (this.short === "noRam") return "Not enough free RAM to start llama-server.";
    return `Not enough free memory: ${layers > 0 ? `with ${layers} expert layers in system RAM, ` : ""}it needs about ${gigabytes(needs.ram)} GB RAM and ${gigabytes(needs.vram)} GB VRAM, and ${gigabytes(free.ramLimit)} GB RAM (free RAM minus 2 GB) and ${gigabytes(free.vram)} GB VRAM are available. Close other programs.`;
  }
}

/** llama-server ended on its own, while it loaded the model or during the run. */
class LlamaServerEndedError extends Schema.TaggedError<LlamaServerEndedError>()(
  "LlamaServerEndedError",
  {
    when: Schema.Literals(["loading", "running"]),
    reason: Schema.Literals(["memoryLimit", "outOfVram", "crashed"]),
    log: Schema.String,
  },
) {
  override get message() {
    const messages: Record<typeof this.reason, string> = {
      memoryLimit: "Not enough RAM for this placement: keep fewer expert layers in system RAM.",
      outOfVram: "Not enough VRAM for this placement: keep more expert layers in system RAM.",
      crashed:
        this.when === "loading"
          ? `llama-server stopped while loading the model. Its log says why: ${this.log}`
          : `llama-server stopped during the run. Its log says why: ${this.log}`,
    };
    return messages[this.reason];
  }
}

export type ServeError =
  | Ollama.OllamaUnreachableError
  | Ollama.OllamaModelError
  | Ollama.OllamaHoldsModelError
  | FreeMemory.FreeMemoryError
  | NoVisionError
  | TooManyExpertLayersError
  | LlamaServerMissingError
  | ModelFileError
  | NotEnoughMemoryError
  | LlamaServerEndedError
  | PlatformError.PlatformError;

/** A running llama-server. */
export interface RunningServer {
  /** Its OpenAI-compatible API, such as `http://127.0.0.1:41234/v1`. */
  readonly api: URL;
  /** Why the server ended, or none while it runs. A request fails a moment before the exit shows. */
  readonly ended: Effect.Effect<Option.Option<LlamaServerEndedError>>;
}

/**
 * The command that runs llama-server under a limit of this many bytes of RAM and no swap, so the
 * kernel stops it instead of the computer slowing down. Tests without a user session leave it out.
 */
export const MemoryLimit = Context.Reference<(bytes: number) => ReadonlyArray<string>>(
  "@rpgtl/server/localModels/MemoryLimit",
  {
    defaultValue: () => (bytes) => [
      "systemd-run",
      "--user",
      "--scope",
      "--quiet",
      "-p",
      `MemoryMax=${Math.floor(bytes)}`,
      "-p",
      "MemorySwapMax=0",
    ],
  },
);

/**
 * Ollama's bundled llama-server, which runs a mixture-of-experts model with the experts of some
 * layers in system RAM. Ollama can't place experts itself.
 */
export class LlamaServer extends Context.Service<
  LlamaServer,
  {
    /**
     * Why llama-server can't run here, or none when it can: Windows has no memory limit for it,
     * and Linux needs Ollama's bundled llama-server with its CUDA library.
     */
    readonly unavailable: Effect.Effect<Option.Option<string>>;
    /**
     * Frees `unload` in Ollama and starts llama-server for Ollama's `model` if the free RAM and
     * VRAM hold it, and stops it when the scope closes. It keeps the experts of at least
     * `expertLayersInRam` layers in system RAM, and of more until the rest fits in free VRAM. Its
     * output goes to the file `log`.
     */
    readonly serve: (options: {
      readonly endpoint: URL;
      readonly model: string;
      readonly unload: ReadonlyArray<string>;
      readonly expertLayersInRam: number;
      /** Requests at once, each with `numCtx` tokens of context. */
      readonly slots: number;
      readonly numCtx: number;
      readonly log: string;
      /** Starts the model's vision part too, for requests with images. */
      readonly vision?: boolean;
      /**
       * Whether a slot reuses the prompt it last answered where the new one starts the same;
       * without it an answer depends only on its own request. On unless set.
       */
      readonly promptCache?: boolean;
    }) => Effect.Effect<RunningServer, ServeError, Scope.Scope>;
  }
>()("@rpgtl/server/localModels/LlamaServer") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const client = yield* HttpClient.HttpClient;
  const ollama = yield* Ollama.Ollama;
  const memory = yield* FreeMemory.FreeMemory;
  const onWindows = yield* OnWindows;
  const libDirs = yield* Config.String("RPGTL_OLLAMA_LIB").pipe(
    Config.map((dir) => [dir]),
    Config.withDefault(["/usr/lib/ollama", "/usr/local/lib/ollama"]),
  );

  const isExecutable = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.type === "File" && (info.mode & 0o111) !== 0),
      Effect.catchTags({ PlatformError: () => Effect.succeed(false) }),
    );

  /** The folder with Ollama's llama-server and the newest CUDA library next to it. */
  const findLib = Effect.gen(function* () {
    for (const dir of libDirs) {
      if (!(yield* isExecutable(path.join(dir, "llama-server")))) continue;
      const names = yield* fs.readDirectory(dir);
      const cuda: Array<string> = [];
      for (const name of names)
        if (/^cuda_v\d+/.test(name) && (yield* fs.exists(path.join(dir, name, "libggml-cuda.so"))))
          cuda.push(name);
      const newest = cuda.toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
      if (newest === undefined)
        return yield* new LlamaServerMissingError({ missing: "cuda", places: dir });
      return { dir, cudaDir: path.join(dir, newest) };
    }
    return yield* new LlamaServerMissingError({
      missing: "llamaServer",
      places: libDirs.join(" or "),
    });
  }).pipe(Effect.withSpan("LlamaServer.findLib"));

  /** The start of the file, doubled until it holds the whole header. */
  const readModel = Effect.fn("LlamaServer.readModel")(
    function* (file: string) {
      const handle = yield* fs.open(file);
      const size = Number((yield* handle.stat).size);
      let length = Math.min(size, 2 ** 20);
      for (;;) {
        const bytes = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
          const read = yield* handle.read(bytes.subarray(filled), { position: BigInt(filled) });
          if (read === 0) break;
          filled += read;
        }
        const header = readGgufHeader(bytes.subarray(0, filled), size);
        if (Result.isSuccess(header)) return header.success;
        if (header.failure !== "endsEarly" || length >= size)
          return yield* new ModelFileError({ file, problem: header.failure });
        length = Math.min(size, length * 2);
      }
    },
    Effect.scoped,
    (self, file) =>
      self.pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            Effect.fail(new ModelFileError({ file, problem: "unreadable", cause })),
        }),
      ),
  );
  // Ollama names its model files after their content, so a file read once stays the same.
  const models = yield* Cache.makeWith(readModel, {
    capacity: 8,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  });

  /** Why the process ended, from how it exited and, for a failed load, what its log says. */
  const whyEnded = Effect.fn("LlamaServer.whyEnded")(function* (
    when: "loading" | "running",
    exit: Exit.Exit<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>,
    log: string,
    logged: Fiber.Fiber<void>,
  ) {
    // The exit code fails only for a process ended by a signal, named in its cause's message.
    // RPGTL's own stop happens when the scope closes, after which nothing asks, so a SIGKILL is
    // the memory limit's.
    const signal = Exit.isFailure(exit)
      ? Option.flatMap(Cause.findErrorOption(exit.cause), (error) =>
          Option.fromNullishOr(/'(SIG\w+)'/.exec(String(error.reason.cause))?.[1]),
        )
      : Option.none();
    if (Option.contains(signal, "SIGKILL"))
      return new LlamaServerEndedError({ when, reason: "memoryLimit", log });
    yield* Fiber.await(logged);
    const tail = yield* fs.readFileString(log).pipe(
      Effect.map((text) => text.trimEnd().split("\n").slice(-50).join("\n")),
      Effect.catchTags({ PlatformError: () => Effect.succeed("") }),
    );
    return new LlamaServerEndedError({
      when,
      reason: /out of memory/i.test(tail) ? "outOfVram" : "crashed",
      log,
    });
  });

  const start = Effect.fn("LlamaServer.start")(function* (options: {
    readonly lib: { readonly dir: string; readonly cudaDir: string };
    readonly file: string;
    readonly projector: Option.Option<string>;
    readonly numCtx: number;
    readonly slots: number;
    readonly ramLimit: number;
    readonly freeVram: number;
    readonly estimate: MemoryEstimate;
    readonly log: string;
    readonly promptCache: boolean;
    /** Whether an earlier start ran out of VRAM, whose lines the log keeps. */
    readonly retry: boolean;
  }) {
    const { lib, log } = options;
    const binary = path.join(lib.dir, "llama-server");
    const env = {
      LD_LIBRARY_PATH: `${lib.dir}:${lib.cudaDir}`,
      GGML_BACKEND_PATH: path.join(lib.cudaDir, "libggml-cuda.so"),
    };
    const version = yield* spawner.string(
      ChildProcess.make(binary, ["--version"], { env, extendEnv: true }),
      { includeStderr: true },
    );
    yield* fs.makeDirectory(path.dirname(log), { recursive: true });
    yield* fs.writeFileString(
      log,
      `${options.retry ? "" : `${version.trimEnd()}\n`}RPGTL estimate for ${options.estimate.expertLayersInRam} expert layers in RAM: RAM ${gigabytes(options.estimate.ram)} GB of ${gigabytes(options.ramLimit)} GB allowed, VRAM ${gigabytes(options.estimate.vram)} GB of ${gigabytes(options.freeVram)} GB free\n`,
      { flag: options.retry ? "a" : "w" },
    );
    const port = yield* freePort;
    const [command = "", ...limit] = (yield* MemoryLimit)(options.ramLimit);
    // Closed after the process stops.
    const logging = yield* Scope.fork(yield* Effect.scope);
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(
          command,
          [
            ...limit,
            binary,
            "--model",
            options.file,
            "--port",
            String(port),
            "--host",
            "127.0.0.1",
            "--no-webui",
            ...Option.match(options.projector, {
              onNone: () => [],
              onSome: (projector) => ["--mmproj", projector],
            }),
            "-c",
            String(options.numCtx * options.slots),
            "-np",
            String(options.slots),
            "--no-jinja",
            "--chat-template",
            "chatml",
            "--cache-type-k",
            "q8_0",
            "--cache-type-v",
            "q8_0",
            "--flash-attn",
            "on",
            "-b",
            "512",
            "-ub",
            "512",
            "--load-mode",
            "none",
            // Its default 8 GB of saved prompts in RAM outgrows the memory limit during a run.
            "--cache-ram",
            "0",
            "--n-cpu-moe",
            String(options.estimate.expertLayersInRam),
            ...(options.promptCache ? [] : ["--no-cache-prompt"]),
          ],
          { env, extendEnv: true, stdin: "ignore", forceKillAfter: Duration.seconds(10) },
        ),
      )
      .pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" && command !== binary
              ? Effect.fail(new LlamaServerMissingError({ missing: "systemdRun", places: command }))
              : Effect.fail(error),
        }),
      );
    const logged = yield* handle.all.pipe(
      Stream.run(fs.sink(log, { flag: "a" })),
      Effect.catchTags({
        PlatformError: (error) => Effect.logWarning("Couldn't write llama-server's log.", error),
      }),
      Effect.forkIn(logging),
    );
    // Once the process is gone its output ends, so the log gets its last lines first.
    yield* Scope.addFinalizer(
      logging,
      Fiber.await(logged).pipe(Effect.timeoutOption(Duration.seconds(1))),
    );
    const exited = Effect.exit(handle.exitCode);

    const api = new URL(`http://127.0.0.1:${port}`);
    const healthy = client.get(new URL("/health", api)).pipe(
      Effect.map((response) => response.status === 200),
      Effect.timeout(Duration.seconds(2)),
      Effect.catchTags({
        HttpClientError: () => Effect.succeed(false),
        TimeoutError: () => Effect.succeed(false),
      }),
    );
    yield* Effect.raceFirst(
      healthy.pipe(
        Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced(Duration.millis(100)) }),
      ),
      exited.pipe(
        Effect.flatMap((exit) => whyEnded("loading", exit, log, logged)),
        Effect.flatMap(Effect.fail),
      ),
    );
    return {
      api: new URL("/v1", api),
      ended: exited.pipe(
        Effect.timeoutOption(Duration.seconds(2)),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (exit) => Effect.asSome(whyEnded("running", exit, log, logged)),
          }),
        ),
        Effect.tap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (ended) => Effect.logWarning(ended.message),
          }),
        ),
      ),
    } satisfies RunningServer;
  });

  const serve = Effect.fn("LlamaServer.serve")(function* (
    options: Parameters<LlamaServer["Service"]["serve"]>[0],
  ) {
    if (onWindows) return yield* new LlamaServerMissingError({ missing: "linux", places: "" });
    const { model, expertLayersInRam, numCtx, slots } = options;
    const vision = options.vision ?? false;
    const shown = yield* ollama.modelFile(options.endpoint, model);
    if (expertLayersInRam > shown.blockCount)
      return yield* new TooManyExpertLayersError({ model, blockCount: shown.blockCount });
    if (vision && Option.isNone(shown.projector)) return yield* new NoVisionError({ model });
    const projector = vision ? shown.projector : Option.none<string>();
    const projectorBytes = yield* Option.match(projector, {
      onNone: () => Effect.succeedNone,
      onSome: (file) =>
        fs.stat(file).pipe(
          Effect.map((info) => Option.some(Number(info.size))),
          Effect.mapError((cause) => new ModelFileError({ file, problem: "unreadable", cause })),
        ),
    });
    const lib = yield* findLib;
    yield* ollama.free(options.endpoint, options.unload);
    const free = { ramLimit: (yield* memory.ram) - ramReserve, vram: yield* memory.vram };
    const placement = {
      expertLayersInRam,
      numCtx,
      slots,
      ...(Option.isSome(projectorBytes) && { projectorBytes: projectorBytes.value }),
    };
    const gguf = yield* Cache.get(models, shown.file);
    const estimated = (result: Result.Result<MemoryEstimate, EstimateProblem>) =>
      Effect.fromResult(
        Result.mapError(result, (problem) => new ModelFileError({ file: shown.file, problem })),
      );
    const estimate = yield* estimated(fittedEstimate(gguf, { ...placement, freeVram: free.vram }));
    const short = free.ramLimit <= 0 ? Option.some("noRam" as const) : shortage(estimate, free);
    if (Option.isSome(short))
      return yield* new NotEnoughMemoryError({
        short: short.value,
        expertLayersInRam: estimate.expertLayersInRam,
        needs: { ram: estimate.ram, vram: estimate.vram },
        free,
      });
    // The estimate's allowance for llama-server's own VRAM is a guess, so a start that runs out
    // of it while loading tries again with the experts of one more layer in RAM.
    const attempt = (
      tried: MemoryEstimate,
      retries: number,
    ): Effect.Effect<RunningServer, ServeError, Scope.Scope> =>
      start({
        lib,
        file: shown.file,
        projector,
        numCtx,
        slots,
        ramLimit: free.ramLimit,
        freeVram: free.vram,
        estimate: tried,
        log: options.log,
        promptCache: options.promptCache ?? true,
        retry: retries > 0,
      }).pipe(
        Effect.catchTags({
          LlamaServerEndedError: (error) =>
            Effect.gen(function* () {
              if (error.reason !== "outOfVram" || retries >= vramRetries) return yield* error;
              const next = yield* estimated(
                estimateMemory(gguf, {
                  ...placement,
                  expertLayersInRam: tried.expertLayersInRam + 1,
                }),
              );
              if (
                next.expertLayersInRam > next.blockCount ||
                next.vram >= tried.vram ||
                next.ram > free.ramLimit
              )
                return yield* error;
              yield* Effect.logWarning(
                `llama-server ran out of VRAM with ${tried.expertLayersInRam} expert layers in RAM; starting it with ${next.expertLayersInRam}.`,
              );
              return yield* attempt(next, retries + 1);
            }),
        }),
      );
    return yield* attempt(estimate, 0);
  });

  const unavailable = onWindows
    ? Effect.succeedSome(new LlamaServerMissingError({ missing: "linux", places: "" }).message)
    : findLib.pipe(
        Effect.as(Option.none<string>()),
        Effect.catchTags({
          LlamaServerMissingError: (error) => Effect.succeedSome(error.message),
          PlatformError: (error) => Effect.succeedSome(error.message),
        }),
      );

  return LlamaServer.of({ unavailable, serve });
});

export const layer = Layer.effect(LlamaServer, make);
