import type { NwjsStatus } from "@rpgtl/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { httpClientAnswering } from "../testUtils/ollama.ts";
import * as Nwjs from "./Nwjs.ts";

/** A release archive like NW.js's, holding only an `nw` file. */
const release = Effect.fn("release")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* fs.makeDirectory(path.join(dir, "src/nwjs-vtest-linux-x64"), { recursive: true });
  yield* fs.writeFileString(path.join(dir, "src/nwjs-vtest-linux-x64/nw"), "#!/bin/sh\n");
  const archive = path.join(dir, "release.tar.gz");
  yield* spawner.exitCode(
    ChildProcess.make("tar", [
      "-czf",
      archive,
      "-C",
      path.join(dir, "src"),
      "nwjs-vtest-linux-x64",
    ]),
  );
  const bytes = yield* fs.readFile(archive);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
});

/**
 * NW.js caching in a new folder, downloading from a server that redirects to a mirror, which
 * answers the release with `answer`, and counting the requests to the mirror.
 */
const nwjsServing = Effect.fn("nwjsServing")(function* (
  answer: (bytes: Uint8Array<ArrayBuffer>) => Response,
  sha256?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped();
  const archive = yield* release(dir);
  const requests = yield* Ref.make(0);
  const client = httpClientAnswering((url) =>
    url.pathname === "/nwjs.tar.gz"
      ? Ref.update(requests, (count) => count + 1).pipe(
          Effect.as(Option.some(answer(new Uint8Array(archive.bytes)))),
        )
      : Effect.succeedSome(
          new Response(null, {
            status: 302,
            headers: { location: "https://mirror.test/nwjs.tar.gz" },
          }),
        ),
  );
  const layer = Nwjs.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        client,
        Layer.succeed(Nwjs.NwjsRelease, {
          version: "vtest",
          url: "https://dl.test/release",
          size: archive.bytes.length,
          sha256: sha256 ?? archive.sha256,
          folder: "nwjs-vtest-linux-x64",
          program: "nw",
        }),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_CACHE_HOME: dir, HOME: "/nowhere" })),
      ),
    ),
  );
  return { layer, requests, folder: `${dir}/rpgtl/nwjs` };
});

/** The first status that passes `until`, as the page hears of it. */
const statusWhen = (nwjs: Nwjs.Nwjs["Service"], until: (status: NwjsStatus) => boolean) =>
  nwjs.changes.pipe(Stream.filter(until), Stream.runHead, Effect.map(Option.getOrThrow));

const downloaded = (nwjs: Nwjs.Nwjs["Service"]) =>
  statusWhen(nwjs, (status) => status.phase._tag !== "Downloading");

it.live("downloads NW.js once, through redirects, checks it and unpacks it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { layer, requests, folder } = yield* nwjsServing((bytes) => new Response(bytes));
    yield* Effect.gen(function* () {
      const nwjs = yield* Nwjs.Nwjs;
      assert.deepInclude(yield* statusWhen(nwjs, () => true), {
        version: "vtest",
        phase: { _tag: "Missing" },
        attempt: 0,
      });
      const heard = yield* nwjs.changes.pipe(
        Stream.takeUntil((status) => status.phase._tag === "Ready"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      assert.deepInclude(yield* nwjs.download, {
        phase: { _tag: "Downloading", received: 0 },
        attempt: 1,
      });
      yield* nwjs.download;
      const statuses = yield* Fiber.join(heard);
      assert.deepInclude(statuses.at(-1), { phase: { _tag: "Ready" }, attempt: 1 });
      assert.deepStrictEqual(statuses.at(-2)?.phase, {
        _tag: "Downloading",
        received: statuses.at(-1)?.size ?? -1,
      });
      assert.strictEqual((yield* nwjs.download).attempt, 1);
      assert.strictEqual(yield* Ref.get(requests), 1);
    }).pipe(Effect.provide(layer));
    assert.isTrue(yield* fs.exists(`${folder}/vtest/nw`));
    assert.deepStrictEqual(yield* fs.readDirectory(folder), ["vtest"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a download that doesn't match its checksum leaves nothing behind and says so", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { layer, folder } = yield* nwjsServing((bytes) => new Response(bytes), "0".repeat(64));
    const done = yield* Effect.flatMap(Nwjs.Nwjs, (nwjs) =>
      Effect.andThen(nwjs.download, downloaded(nwjs)),
    ).pipe(Effect.provide(layer));
    assert.strictEqual(done.phase._tag, "Missing");
    assert.isDefined(done.phase._tag === "Missing" ? done.phase.error : undefined);
    assert.deepStrictEqual(yield* fs.readDirectory(folder), []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("RPGTL exiting during a download removes what it got so far", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Sends the first bytes, then nothing more.
    const { layer, folder } = yield* nwjsServing(
      (bytes) =>
        new Response(
          new ReadableStream({ start: (controller) => controller.enqueue(bytes.subarray(0, 10)) }),
        ),
    );
    yield* Effect.flatMap(Nwjs.Nwjs, (nwjs) =>
      Effect.andThen(
        nwjs.download,
        statusWhen(
          nwjs,
          (status) => status.phase._tag === "Downloading" && status.phase.received > 0,
        ),
      ),
    ).pipe(Effect.provide(layer));
    assert.deepStrictEqual(yield* fs.readDirectory(folder), []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
