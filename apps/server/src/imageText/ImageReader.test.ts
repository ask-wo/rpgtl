import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";
import * as TestClock from "effect/testing/TestClock";
import { NvidiaSmi } from "../localModels/FreeMemory.ts";
import { line } from "../testUtils/imageReader.ts";
import { httpClientAnswering } from "../testUtils/ollama.ts";
import { readerNeeds } from "../testUtils/state.ts";
import * as ImageReader from "./ImageReader.ts";
import * as ImageReaderSetup from "./ImageReaderSetup.ts";

/** A reader that runs at `http://127.0.0.1:5001` once started. */
const startedReader = ImageReader.ReaderProcess.of({
  start: Effect.succeed({ base: new URL("http://127.0.0.1:5001"), output: "/cache/reader.log" }),
});

/** The image reader over a fake one that answers each route's JSON request with `answer`. */
const readerAnswering = (answer: (route: string, body: unknown) => Option.Option<Response>) =>
  ImageReader.clientLayer.pipe(
    Layer.provide(httpClientAnswering((url, body) => Effect.succeed(answer(url.pathname, body)))),
    Layer.provide(Layer.succeed(ImageReader.ReaderProcess, startedReader)),
    Layer.provide(readerNeeds),
  );

/**
 * A Python that serves `/health` on the port uvicorn is given, after printing what it was given,
 * or fails as the reader does when its models folder holds a `missing` file.
 */
const fakePython = `#!/bin/sh
echo "device $IMAGE_TEXT_DEVICE in $PWD"
if [ -f "$IMAGE_TEXT_MODELS/missing" ]; then echo "Missing image text models" >&2; exit 1; fi
exec node -e 'require("node:http").createServer((_, answer) => answer.end("{}")).listen(Number(process.argv[1]), "127.0.0.1")' "$7"
`;

/** The reader's process over an installation whose Python is `fakePython`. */
const installed = Effect.fn("installed")(function* (options: { readonly missing: boolean }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  const installation: ImageReaderSetup.Installation = {
    python: path.join(dir, "python"),
    sources: dir,
    models: path.join(dir, "models"),
    device: "gpu",
    log: path.join(dir, "reader.log"),
  };
  yield* fs.writeFileString(installation.python, fakePython, { mode: 0o755 });
  yield* fs.makeDirectory(installation.models);
  if (options.missing) yield* fs.writeFileString(path.join(installation.models, "missing"), "");
  const layer = ImageReader.processLayer.pipe(
    Layer.provide(
      Layer.succeed(
        ImageReaderSetup.ImageReaderSetup,
        ImageReaderSetup.ImageReaderSetup.of({
          changes: Stream.empty,
          setUp: () => Effect.die("not set up here"),
          remove: Effect.die("not removed here"),
          removeKorean: Effect.die("not removed here"),
          installation: Effect.succeed(installation),
          external: Option.none(),
        }),
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
  );
  return { layer, installation };
});

it.live("the reader starts on a free port in its sources and stops with its scope", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { layer, installation } = yield* installed({ missing: false });
    const process = yield* ImageReader.ReaderProcess.pipe(Effect.provide(layer));
    const scope = yield* Scope.make();
    const reader = yield* process.start.pipe(Scope.provide(scope));
    assert.strictEqual(reader.output, installation.log);
    const health = HttpClient.get(new URL("/health", reader.base)).pipe(
      Effect.map((response) => response.status),
      Effect.catchTags({ HttpClientError: (error) => Effect.succeed(error.reason._tag) }),
    );
    assert.strictEqual(yield* health, 200);
    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(yield* health, "TransportError");
    assert.include(
      yield* fs.readFileString(installation.log),
      `device gpu in ${installation.sources}`,
    );
  }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);

it.live("a reader that exits while starting says where its log is", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { layer, installation } = yield* installed({ missing: true });
    const process = yield* ImageReader.ReaderProcess.pipe(Effect.provide(layer));
    const error = yield* Effect.flip(Effect.scoped(process.start));
    assert.include(error, { _tag: "ImageReaderError", operation: "start", problem: "stopped" });
    assert.include(error.message, installation.log);
    assert.include(yield* fs.readFileString(installation.log), "Missing image text models");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a reader that isn't set up says to set it up", () =>
  Effect.gen(function* () {
    const reader = yield* ImageReader.ImageReader;
    const error = yield* Effect.flip(reader.start);
    assert.deepInclude(error, { _tag: "ImageReaderMissingError", missing: "reader" });
  }).pipe(
    Effect.provide(
      ImageReader.layer.pipe(
        Layer.provide(readerNeeds),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

const areasOf = (body: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ areas: Schema.Array(Schema.Unknown) }))(body).areas;

const image = new Uint8Array([1, 2, 3]);
const read = {
  width: 10,
  height: 10,
  lines: [
    { ...Struct.omit(line("开始", [0, 0, 5, 5]), ["contrast"]), reader: "paddle" as const },
    { ...line("退出", [5, 5, 9, 9]), reader: "paddle" as const },
  ],
};

it.effect("only lines without a contrast are measured, and answers that don't fit fail", () =>
  Effect.gen(function* () {
    const reader = yield* ImageReader.ImageReader;
    const measured = yield* reader.measure(image, read);
    assert.deepStrictEqual(
      measured.lines.map((found) => found.contrast),
      [80, 80],
    );
    // Measured lines need no request, which would fail here.
    assert.strictEqual(yield* reader.measure(image, measured), measured);

    const prepared = yield* Effect.flip(reader.prepare(image, read.lines, [[0], [1]], "chinese"));
    assert.include(prepared, { operation: "prepare", problem: "invalidAnswer" });
  }).pipe(
    Effect.provide(
      readerAnswering((route, body) => {
        if (route === "/contrast")
          return Option.some(Response.json({ contrasts: areasOf(body).map(() => 80) }));
        // No block prepared of the two asked for.
        if (route === "/prepare") return Option.some(Response.json({ erased: "AAAA", blocks: [] }));
        return Option.none();
      }),
    ),
  ),
);

it.effect("a request the reader fails says where its log is", () =>
  Effect.gen(function* () {
    const reader = yield* ImageReader.ImageReader;
    const failed = yield* Effect.flip(reader.measure(image, read));
    assert.include(failed, { operation: "contrast", problem: "failed" });
    assert.include(failed.message, "See /cache/reader.log for why.");
  }).pipe(
    Effect.provide(
      readerAnswering(() => Option.some(new Response("out of memory", { status: 500 }))),
    ),
  ),
);

it.effect(
  "a reader that doesn't answer within 5 minutes is told apart from one that isn't running",
  () =>
    Effect.gen(function* () {
      const reader = yield* ImageReader.ImageReader;
      const asked = yield* Effect.forkChild(Effect.flip(reader.measure(image, read)));
      yield* TestClock.adjust("5 minutes");
      const error = yield* Fiber.join(asked);
      assert.include(error, { operation: "contrast", problem: "timedOut" });
    }).pipe(
      Effect.provide(
        ImageReader.clientLayer.pipe(
          Layer.provide(httpClientAnswering(() => Effect.never)),
          Layer.provide(Layer.succeed(ImageReader.ReaderProcess, startedReader)),
          Layer.provide(readerNeeds),
        ),
      ),
    ),
);

/** The reader's process and setup with `RPGTL_IMAGE_READER` set to `address`. */
const withAddress = (
  address: string,
  client: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer,
) =>
  ImageReader.processLayer.pipe(
    Layer.provideMerge(ImageReaderSetup.layer),
    Layer.provide(
      Layer.mergeAll(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ HOME: "/nowhere", RPGTL_IMAGE_READER: address }),
        ),
        Layer.succeed(NvidiaSmi, "/nowhere/nvidia-smi"),
        client,
        NodeServices.layer,
      ),
    ),
  );

it.effect(
  "RPGTL_IMAGE_READER names a reader started outside RPGTL, which RPGTL uses instead and unloads when it stops",
  () => {
    const requests: Array<string> = [];
    let answering = true;
    const client = httpClientAnswering((url) =>
      Effect.sync(() => {
        requests.push(url.pathname);
        return answering ? Option.some(Response.json({})) : Option.none();
      }),
    );
    return Effect.gen(function* () {
      const setup = yield* ImageReaderSetup.ImageReaderSetup;
      const process = yield* ImageReader.ReaderProcess;
      const status = yield* setup.changes.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      assert.include(status, { ready: false, external: "http://127.0.0.1:5001" });
      const reader = yield* Effect.scoped(process.start);
      assert.strictEqual(reader.base.origin, "http://127.0.0.1:5001");
      assert.deepStrictEqual(requests, ["/health", "/unload"]);

      answering = false;
      const error = yield* Effect.flip(Effect.scoped(process.start));
      assert.include(error, { _tag: "ImageReaderError", operation: "start", problem: "stopped" });
    }).pipe(Effect.provide(withAddress("http://127.0.0.1:5001", client)));
  },
);

it.effect("RPGTL_IMAGE_READER on another computer stops the server from starting", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(Layer.build(withAddress("http://example.com:5001")));
    assert.include(String(error), "must be an address on this computer");
  }).pipe(Effect.scoped),
);
