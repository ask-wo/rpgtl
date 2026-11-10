import {
  type Box,
  ImageLine,
  type ImageReaderSetupStatus,
  type ImageResult,
  type ImageRun,
  PreparedBlock,
  type SourceLanguage,
} from "@rpgtl/contracts";
import type { ImageRead } from "@rpgtl/domain";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Base64 from "effect/encoding/Base64";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { freePort } from "../freePort.ts";
import * as RunKinds from "../runs/RunKinds.ts";
import * as ImageReaderSetup from "./ImageReaderSetup.ts";
import { ImageReaderMissingError } from "./ImageReaderSetup.ts";

const Operation = Schema.Literals(["start", "models", "read", "contrast", "prepare", "flatten"]);
type Operation = typeof Operation.Type;

/** The image text reader (`apps/image-reader`) couldn't do what it was asked. */
export class ImageReaderError extends Schema.TaggedError<ImageReaderError>()("ImageReaderError", {
  operation: Operation,
  problem: Schema.Literals(["stopped", "failed", "invalidAnswer", "timedOut"]),
  /** Where the reader's output is, such as its log file. */
  output: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message() {
    switch (this.problem) {
      case "stopped":
        return this.operation === "start"
          ? `The image text reader stopped while starting. See ${this.output} for why.`
          : `The image text reader stopped (${this.operation}). See ${this.output} for why.`;
      case "failed":
        return `The image text reader failed (${this.operation}). See ${this.output} for why.`;
      case "invalidAnswer":
        return `The image text reader gave an answer RPGTL can't use (${this.operation}).`;
      case "timedOut":
        return this.operation === "start"
          ? `The image text reader didn't start within 2 minutes. See ${this.output} for why.`
          : `The image text reader took longer than 5 minutes (${this.operation}).`;
    }
  }
}

const ReadAnswer = Schema.Struct({
  width: Schema.Finite,
  height: Schema.Finite,
  lines: Schema.Array(ImageLine.mapFields(Struct.omit(["reader", "rough", "enlarged"]))),
});

const HealthAnswer = Schema.Struct({
  ocr: Schema.Struct({
    detection: Schema.String,
    /** The installed recognizers' models: `general`, and `korean` once it is set up. */
    recognizers: Schema.Struct({
      general: Schema.String,
      korean: Schema.optionalKey(Schema.String),
    }),
  }),
  inpaint: Schema.String,
});

const Contrast = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 255 }));
const ContrastAnswer = Schema.Struct({ contrasts: Schema.Array(Contrast) });

const PrepareAnswer = Schema.Struct({
  erased: Schema.Uint8ArrayFromBase64,
  blocks: Schema.Array(PreparedBlock.mapFields(Struct.omit(["lines", "grow"]))),
});

const imageBody = (image: Uint8Array) => HttpClientRequest.setBody(HttpBody.uint8Array(image));

const boxParam = (box: Box) => box.join(",");

/** How far the erased areas are grown beyond the lines' polygons. */
const eraseGrow = 4;
/** The colour transparent parts of an image are drawn on before it is read. */
const background = "128,128,128";

const post =
  (route: string, query: Record<string, string> = {}) =>
  (base: URL) =>
    HttpClientRequest.post(new URL(route, base)).pipe(
      HttpClientRequest.setUrlParams({ background, ...query }),
    );

/** A running image reader. */
export interface RunningReader {
  readonly base: URL;
  /** Where its output is, such as its log file. */
  readonly output: string;
}

/** Starts the image reader that `ImageReaderSetup` set up, on a free port of this computer. */
export class ReaderProcess extends Context.Service<
  ReaderProcess,
  {
    /** The reader once it answers; it stops when the scope closes. */
    readonly start: Effect.Effect<
      RunningReader,
      ImageReaderError | ImageReaderMissingError,
      Scope.Scope
    >;
  }
>()("@rpgtl/server/imageText/ReaderProcess") {}

const makeProcess = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const client = yield* HttpClient.HttpClient;
  const setup = yield* ImageReaderSetup.ImageReaderSetup;

  const start = Effect.gen(function* () {
    const installation = yield* setup.installation;
    const log = installation.log;
    const failure = (problem: ImageReaderError["problem"]) => (cause?: unknown) =>
      new ImageReaderError({
        operation: "start",
        problem,
        output: log,
        ...(cause !== undefined && { cause }),
      });
    yield* fs.writeFileString(log, "").pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.logWarning("Couldn't start the image reader's log.", error),
      }),
    );
    const port = yield* freePort;
    // Closed after the process stops.
    const logging = yield* Scope.fork(yield* Effect.scope);
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(
          installation.python,
          [
            "-m",
            "uvicorn",
            "server:app",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--workers",
            "1",
            "--no-access-log",
          ],
          {
            cwd: installation.sources,
            env: {
              IMAGE_TEXT_DEVICE: installation.device,
              IMAGE_TEXT_MODELS: installation.models,
              PYTHONUNBUFFERED: "1",
              PYTHONUTF8: "1",
            },
            extendEnv: true,
            stdin: "ignore",
            forceKillAfter: Duration.seconds(10),
          },
        ),
      )
      .pipe(Effect.mapError(failure("stopped")));
    const logged = yield* handle.all.pipe(
      Stream.run(fs.sink(log, { flag: "a" })),
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.logWarning("Couldn't write the image reader's log.", error),
      }),
      Effect.forkIn(logging),
    );
    // Once the process is gone its output ends, so the log gets its last lines first.
    yield* Scope.addFinalizer(
      logging,
      Fiber.await(logged).pipe(Effect.timeoutOption(Duration.seconds(1))),
    );

    const base = new URL(`http://127.0.0.1:${port}`);
    const healthy = client.get(new URL("/health", base)).pipe(
      Effect.map((response) => response.status === 200),
      Effect.timeout(Duration.seconds(2)),
      Effect.catchTags({
        HttpClientError: () => Effect.succeed(false),
        TimeoutError: () => Effect.succeed(false),
      }),
    );
    yield* Effect.raceFirst(
      healthy.pipe(
        Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced(Duration.millis(200)) }),
      ),
      Effect.exit(handle.exitCode).pipe(
        Effect.flatMap((exit) => Effect.fail(failure("stopped")(exit))),
      ),
    ).pipe(
      Effect.timeoutOrElse({
        duration: Duration.minutes(2),
        orElse: () => Effect.fail(failure("timedOut")()),
      }),
    );
    return { base, output: log };
  }).pipe(Effect.withSpan("ReaderProcess.start"));

  return ReaderProcess.of({ start });
});

/** Starts the installed reader, or uses the one started outside RPGTL. */
export const processLayer = Layer.effect(
  ReaderProcess,
  Effect.gen(function* () {
    const { external } = yield* ImageReaderSetup.ImageReaderSetup;
    if (Option.isNone(external)) return yield* makeProcess;
    const client = yield* HttpClient.HttpClient;
    const base = external.value;
    const output = `the output of the reader at ${base.origin}`;
    return ReaderProcess.of({
      // Stopping it can't end its process, so it unloads its models instead.
      start: Effect.gen(function* () {
        yield* client.get(new URL("/health", base)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError(
            (cause) =>
              new ImageReaderError({ operation: "start", problem: "stopped", output, cause }),
          ),
        );
        yield* Effect.addFinalizer(() =>
          client.post(new URL("/unload", base)).pipe(
            Effect.catchTags({
              HttpClientError: (error) =>
                Effect.logWarning("The image reader didn't unload its models.", error),
            }),
          ),
        );
        return { base, output };
      }),
    });
  }),
);

/** Why the reader couldn't answer. */
export type ReaderFailure = ImageReaderError | ImageReaderMissingError;

/**
 * The image text reader, a Paddle OCR service (`apps/image-reader`) RPGTL starts on this
 * computer when a request needs it. It reads, measures, erases and flattens images.
 */
export class ImageReader extends Context.Service<
  ImageReader,
  {
    /** Starts the reader unless it runs. */
    readonly start: Effect.Effect<void, ReaderFailure>;
    /**
     * The models the reader reads a game in `language` and erases with, as it names them. Fails
     * when it has no recognizer for the language.
     */
    readonly models: (
      language: SourceLanguage,
    ) => Effect.Effect<Pick<ImageRun, "detection" | "recognition" | "inpainting">, ReaderFailure>;
    /**
     * The lines in the image, or in `crop` of it, read at `scale` times its size with the
     * recognizer for the game's language.
     */
    readonly read: (
      image: Uint8Array,
      options: {
        readonly language: SourceLanguage;
        readonly crop?: Box;
        readonly scale?: number;
      },
    ) => Effect.Effect<ImageRead, ReaderFailure>;
    /** The read with each line's contrast, measured where a line lacks it. */
    readonly measure: (
      image: Uint8Array,
      read: ImageRead,
    ) => Effect.Effect<ImageRead, ReaderFailure>;
    /** The image with the blocks' lines erased, and how to draw the English into each block. */
    readonly prepare: (
      image: Uint8Array,
      lines: ImageResult["lines"],
      blocks: ReadonlyArray<ReadonlyArray<number>>,
      language: SourceLanguage,
    ) => Effect.Effect<
      { readonly erased: Uint8Array; readonly blocks: ReadonlyArray<PreparedBlock> },
      ReaderFailure
    >;
    /** The image as a PNG on the background, or `crop` of it with `mark` outlined in red. */
    readonly flatten: (
      image: Uint8Array,
      options?: { readonly crop: Box; readonly mark: Box },
    ) => Effect.Effect<Uint8Array, ReaderFailure>;
    /** Stops the reader, which frees its models, until the next request starts it. */
    readonly stop: Effect.Effect<void>;
    /**
     * Deletes the reader's folder, or only its Korean model, unless images are read or setting
     * up runs. The reader stops first, as Windows locks the files of a running process.
     */
    readonly remove: (
      which: "reader" | "korean",
    ) => Effect.Effect<
      ImageReaderSetupStatus,
      | RunKinds.ReadingImagesError
      | RunKinds.ReaderRemovingError
      | ImageReaderSetup.ImageReaderRemoveError
    >;
  }
>()("@rpgtl/server/imageText/ImageReader") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const process = yield* ReaderProcess;
  const setup = yield* ImageReaderSetup.ImageReaderSetup;
  const runKinds = yield* RunKinds.RunKinds;
  const running = yield* SynchronizedRef.make(
    Option.none<RunningReader & { readonly scope: Scope.Closeable }>(),
  );
  const stopped = SynchronizedRef.updateEffect(running, (now) =>
    Option.match(now, {
      onNone: () => Effect.succeed(now),
      onSome: ({ scope }) => Effect.as(Scope.close(scope, Exit.void), Option.none()),
    }),
  );
  yield* Effect.addFinalizer(() => stopped);

  const started = SynchronizedRef.modifyEffect(running, (now) =>
    Option.match(now, {
      onSome: (reader) => Effect.succeed([reader, now] as const),
      onNone: () =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const reader = yield* process.start.pipe(
            Scope.provide(scope),
            Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
          );
          return [reader, Option.some({ ...reader, scope })] as const;
        }),
    }),
  );

  /** The reader's answer to `request`, as `answer` reads its body. */
  const ask = Effect.fnUntraced(function* <A, E>(
    operation: Exclude<Operation, "start">,
    request: (base: URL) => HttpClientRequest.HttpClientRequest,
    answer: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>,
  ) {
    const { base, output } = yield* started;
    const failure = (problem: ImageReaderError["problem"]) => (cause?: unknown) =>
      new ImageReaderError({ operation, problem, output, ...(cause !== undefined && { cause }) });
    return yield* client.execute(request(base)).pipe(
      // A reader that stopped answering starts again on the next request.
      Effect.catchTags({
        HttpClientError: (error) =>
          error.reason._tag === "TransportError"
            ? Effect.andThen(stopped, Effect.fail(failure("stopped")(error)))
            : Effect.fail(failure("failed")(error)),
      }),
      Effect.flatMap((response) =>
        HttpClientResponse.filterStatusOk(response).pipe(Effect.mapError(failure("failed"))),
      ),
      Effect.flatMap((response) =>
        answer(response).pipe(Effect.mapError(failure("invalidAnswer"))),
      ),
      Effect.timeoutOrElse({
        duration: Duration.minutes(5),
        orElse: () => Effect.fail(failure("timedOut")()),
      }),
    );
  });

  const invalid = (operation: Operation, cause: string) =>
    Effect.flatMap(started, ({ output }) =>
      Effect.fail(new ImageReaderError({ operation, problem: "invalidAnswer", output, cause })),
    );

  const start = Effect.asVoid(started).pipe(Effect.withSpan("ImageReader.start"));

  const models = Effect.fn("ImageReader.models")(function* (language: SourceLanguage) {
    const { ocr, inpaint } = yield* ask(
      "models",
      (base) => HttpClientRequest.get(new URL("/health", base)),
      HttpClientResponse.schemaBodyJson(HealthAnswer),
    );
    const recognition = language === "korean" ? ocr.recognizers.korean : ocr.recognizers.general;
    if (recognition === undefined) return yield* new ImageReaderMissingError({ missing: "korean" });
    return { detection: ocr.detection, recognition, inpainting: inpaint };
  });

  const read = Effect.fn("ImageReader.read")(function* (
    image: Uint8Array,
    options: { readonly language: SourceLanguage; readonly crop?: Box; readonly scale?: number },
  ) {
    const answer = yield* ask(
      "read",
      (base) =>
        post("/read", {
          language: options.language,
          ...(options.crop && { crop: boxParam(options.crop) }),
          ...(options.scale !== undefined && { scale: String(options.scale) }),
        })(base).pipe(imageBody(image)),
      HttpClientResponse.schemaBodyJson(ReadAnswer),
    );
    return {
      ...answer,
      lines: answer.lines.map((line) => ({ ...line, reader: "paddle" as const })),
    } satisfies ImageRead;
  });

  const measure = Effect.fn("ImageReader.measure")(function* (image: Uint8Array, found: ImageRead) {
    if (found.lines.every((line) => line.contrast !== undefined)) return found;
    const { contrasts } = yield* ask(
      "contrast",
      (base) =>
        post("/contrast")(base).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            image: Base64.encode(image),
            areas: found.lines.map((line) => line.polygon),
          }),
        ),
      HttpClientResponse.schemaBodyJson(ContrastAnswer),
    );
    if (contrasts.length !== found.lines.length)
      return yield* invalid(
        "contrast",
        `${contrasts.length} contrasts for ${found.lines.length} lines`,
      );
    return {
      ...found,
      lines: found.lines.map((line, index) => ({ ...line, contrast: contrasts[index] ?? 0 })),
    };
  });

  const prepare = Effect.fn("ImageReader.prepare")(function* (
    image: Uint8Array,
    lines: ImageResult["lines"],
    blocks: ReadonlyArray<ReadonlyArray<number>>,
    language: SourceLanguage,
  ) {
    const answer = yield* ask(
      "prepare",
      (base) =>
        post("/prepare")(base).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            image: Base64.encode(image),
            grow: eraseGrow,
            language,
            lines: lines.map(({ text, polygon, box }) => ({ text, polygon, box })),
            blocks,
          }),
        ),
      HttpClientResponse.schemaBodyJson(PrepareAnswer),
    );
    if (answer.blocks.length !== blocks.length)
      return yield* invalid(
        "prepare",
        `${answer.blocks.length} blocks prepared for ${blocks.length}`,
      );
    return {
      erased: answer.erased,
      blocks: answer.blocks.map((block, index) => ({
        ...block,
        lines: blocks[index] ?? [],
        grow: eraseGrow,
      })),
    };
  });

  const flatten = Effect.fn("ImageReader.flatten")(function* (
    image: Uint8Array,
    options?: { readonly crop: Box; readonly mark: Box },
  ) {
    const bytes = yield* ask(
      "flatten",
      (base) =>
        post(
          "/flatten",
          options ? { crop: boxParam(options.crop), mark: boxParam(options.mark) } : {},
        )(base).pipe(imageBody(image)),
      (response) => response.arrayBuffer,
    );
    return new Uint8Array(bytes);
  });

  const stop = stopped.pipe(Effect.withSpan("ImageReader.stop"));

  const remove = Effect.fn("ImageReader.remove")(function* (which: "reader" | "korean") {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* runKinds.readerRemoval;
        yield* stopped;
        return yield* which === "korean" ? setup.removeKorean : setup.remove;
      }),
    );
  }, Effect.uninterruptible);

  return ImageReader.of({ start, models, read, measure, prepare, flatten, stop, remove });
});

/** The reader over `ReaderProcess`. */
export const clientLayer = Layer.effect(ImageReader, make);

export const layer = clientLayer.pipe(Layer.provide(processLayer));
