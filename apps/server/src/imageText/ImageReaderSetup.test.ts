import type { ImageReaderSetupStatus } from "@rpgtl/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import { NvidiaSmi } from "../localModels/FreeMemory.ts";
import { OnWindows } from "../OnWindows.ts";
import { httpClientAnswering } from "../testUtils/ollama.ts";
import * as ImageReaderSetup from "./ImageReaderSetup.ts";

/**
 * A uv that only knows `sync`: its dry run would install numpy and torch, and otherwise it makes
 * the project environment's `python` (in `bin`, and in `Scripts` as Windows has it), which says
 * it downloads half of LaMa and writes a model file named after the script it runs into the
 * folder it is given, and a `korean` folder when asked for it. It fails when the reader's
 * sources, where uv runs, hold a `fail` file.
 */
const fakeUv = `#!/bin/sh
echo "uv $*"
if [ "$2" = "--dry-run" ]; then printf 'Using CPython 3.12.1\\n + numpy==2.2.6\\n + torch==2.9.0+cpu\\n' >&2; exit 0; fi
if [ -f "$PWD/fail" ]; then echo "error: no matching distribution" >&2; exit 1; fi
echo "downloading through $HTTPS_PROXY"
mkdir -p "$UV_PROJECT_ENVIRONMENT/bin" "$UV_CACHE_DIR"
cat > "$UV_PROJECT_ENVIRONMENT/bin/python" <<'PYTHON'
#!/bin/sh
echo "@rpgtl part lamaDownload"
echo "@rpgtl bytes 50 100"
mkdir -p "$2" && echo converted > "$2/$(basename "$1" .py).onnx"
for model in "$@"; do
  if [ "$model" = korean ]; then mkdir -p "$2/korean" && echo converted > "$2/korean/ocr_rec.onnx"; fi
done
PYTHON
chmod +x "$UV_PROJECT_ENVIRONMENT/bin/python"
mkdir -p "$UV_PROJECT_ENVIRONMENT/Scripts"
cp "$UV_PROJECT_ENVIRONMENT/bin/python" "$UV_PROJECT_ENVIRONMENT/Scripts/python.exe"
`;

const torch =
  "https://torch.test/torch-2.9.0%2Bcpu-cp312-cp312-win_amd64.manylinux_2_17_x86_64.whl";
/** A lockfile where numpy's wheel fits every platform and torch's size isn't given. */
const lock = `
requires-python = "==3.12.*"
wheels = [
    { url = "https://files.test/numpy-2.2.6-cp312-cp312-win_amd64.manylinux_2_17_x86_64.whl", hash = "sha256:a", size = 2000 },
    { url = "https://files.test/numpy-2.2.6-cp312-cp312-macosx_14_0_arm64.whl", hash = "sha256:b", size = 1000 },
    { url = "${torch}", hash = "sha256:c" },
]
`;

/** The image reader's setup in a new cache folder, downloading the fake uv. */
const setupServing = Effect.fn("setupServing")(function* (options: {
  readonly failing: boolean;
  readonly windows?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const dir = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(path.join(dir, "src/fake-uv"), { recursive: true });
  yield* fs.writeFileString(path.join(dir, "src/fake-uv/uv"), fakeUv, { mode: 0o755 });
  const archive = path.join(dir, "uv.tar.gz");
  yield* spawner.exitCode(
    ChildProcess.make("tar", ["-czf", archive, "-C", path.join(dir, "src"), "fake-uv"]),
  );
  const bytes = yield* fs.readFile(archive);
  const sources = path.join(dir, "image-reader");
  for (const project of [
    sources,
    path.join(sources, "convert/ocr"),
    path.join(sources, "convert/lama"),
  ]) {
    yield* fs.makeDirectory(project, { recursive: true });
    yield* fs.writeFileString(path.join(project, "uv.lock"), lock);
  }
  if (options.failing) yield* fs.writeFileString(path.join(sources, "fail"), "");
  const layer = ImageReaderSetup.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        httpClientAnswering((url) =>
          Effect.succeedSome(
            url.href === torch
              ? new Response(null, { headers: { "content-length": "3000" } })
              : new Response(new Uint8Array(bytes)),
          ),
        ),
        Layer.succeed(ImageReaderSetup.UvRelease, {
          what: "uv",
          url: "https://uv.test/uv.tar.gz",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          folder: "fake-uv",
          program: "uv",
        }),
        Layer.succeed(ImageReaderSetup.ReaderSources, sources),
        Layer.succeed(NvidiaSmi, "/nowhere/nvidia-smi"),
        Layer.succeed(OnWindows, options.windows ?? false),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_CACHE_HOME: dir, HOME: "/nowhere" })),
      ),
    ),
  );
  return { layer, folder: path.join(dir, "rpgtl/image-reader"), sources };
});

const settingUp = ({ phase }: ImageReaderSetupStatus) =>
  phase._tag === "SettingUp" ? phase : undefined;

/** Why the last setting up failed, once it has. */
const failure = ({ phase }: ImageReaderSetupStatus) =>
  phase._tag === "Idle" ? phase.error : undefined;

/** The first status that passes `until`, as the page hears of it. */
const statusWhen = (
  setup: ImageReaderSetup.ImageReaderSetup["Service"],
  until: (status: ImageReaderSetupStatus) => boolean,
) => setup.changes.pipe(Stream.filter(until), Stream.runHead, Effect.map(Option.getOrThrow));

it.live(
  "sets the reader up for the processor, converts the models and clears what it no longer needs",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { layer, folder, sources } = yield* setupServing({ failing: false });
      yield* Effect.gen(function* () {
        const setup = yield* ImageReaderSetup.ImageReaderSetup;
        assert.include(yield* statusWhen(setup, () => true), { device: "cpu", ready: false });
        const heard = yield* setup.changes.pipe(
          Stream.takeUntil((status) => status.ready),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        assert.strictEqual(settingUp(yield* setup.setUp({ korean: false }))?.step, "uv");
        const statuses = yield* Fiber.join(heard);
        // numpy's wheel from the lockfile and torch's as its server says, once though all three
        // syncs plan them.
        assert.deepInclude(
          statuses
            .map(settingUp)
            .filter((phase) => phase?.step === "packages")
            .map((phase) => phase?.downloading),
          { done: 0, total: 5000 },
        );
        assert.isTrue(
          statuses
            .map(settingUp)
            .some(
              (phase) =>
                phase?.part === "lamaDownload" &&
                phase.downloading?.done === 50 &&
                phase.downloading.total === 100,
            ),
        );
        const done = statuses.at(-1);
        assert.include(done, { ready: true, device: "cpu" });
        assert.deepStrictEqual(done?.phase, { _tag: "Idle" });
        const installation = yield* setup.installation;
        assert.strictEqual(installation.device, "cpu");
        assert.isTrue(yield* fs.exists(installation.python));
        assert.deepStrictEqual((yield* fs.readDirectory(installation.models)).toSorted(), [
          "convert_lama.onnx",
          "convert_ocr.onnx",
        ]);
      }).pipe(Effect.provide(layer));
      assert.match(
        yield* fs.readFileString(`${folder}/setup.log`),
        /downloading through http:\/\/127\.0\.0\.1:\d+/,
      );
      const left = yield* fs.readDirectory(folder);
      for (const gone of ["convert-ocr", "convert-lama", "cache", "models.part"])
        assert.notInclude(left, gone);
      // A new RPGTL whose conversion takes other packages sets the reader up again.
      yield* fs.writeFileString(`${sources}/convert/ocr/uv.lock`, `${lock}# changed\n`);
      const updated = yield* Effect.flatMap(ImageReaderSetup.ImageReaderSetup, (setup) =>
        statusWhen(setup, () => true),
      ).pipe(Effect.provide(Layer.fresh(layer)));
      assert.include(updated, { ready: false, onDisk: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "a failing install says why, leaves the reader not set up, and what it left can be deleted",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { layer, folder } = yield* setupServing({ failing: true });
      yield* Effect.gen(function* () {
        const setup = yield* ImageReaderSetup.ImageReaderSetup;
        assert.strictEqual((yield* statusWhen(setup, () => true)).attempt, 0);
        assert.strictEqual((yield* setup.setUp({ korean: false })).attempt, 1);
        const failed = yield* statusWhen(setup, (status) => failure(status) !== undefined);
        assert.include(failed, { ready: false, onDisk: true, attempt: 1 });
        assert.include(yield* fs.readFileString(`${folder}/setup.log`), "no matching distribution");
        // What the attempt left can be deleted.
        assert.include(yield* setup.remove, { ready: false, onDisk: false, attempt: 1 });
        assert.include(failure(failed), `${folder}/setup.log`);
        assert.include(failure(failed), ": error: no matching distribution (log: ");
        const missing = yield* Effect.flip(setup.installation);
        assert.strictEqual(missing._tag, "ImageReaderMissingError");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("removing the reader deletes its folder", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { layer, folder } = yield* setupServing({ failing: false });
    yield* Effect.gen(function* () {
      const setup = yield* ImageReaderSetup.ImageReaderSetup;
      yield* setup.setUp({ korean: false });
      yield* statusWhen(setup, (status) => status.ready);
      assert.include(yield* setup.remove, { ready: false });
    }).pipe(Effect.provide(layer));
    assert.isFalse(yield* fs.exists(folder));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("setting up waits while the reader's folder is being deleted", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { layer, folder } = yield* setupServing({ failing: false });
    const gate = yield* Deferred.make<void>();
    const gated = yield* Ref.make(false);
    const slowRemoval = Layer.succeed(FileSystem.FileSystem, {
      ...fs,
      remove: (file, options) =>
        Ref.get(gated).pipe(
          Effect.flatMap((on) => (on ? Deferred.await(gate) : Effect.void)),
          Effect.andThen(fs.remove(file, options)),
        ),
    });
    yield* Effect.gen(function* () {
      const setup = yield* ImageReaderSetup.ImageReaderSetup;
      yield* setup.setUp({ korean: false });
      yield* statusWhen(setup, (status) => status.ready);
      yield* Ref.set(gated, true);

      const removal = yield* Effect.forkChild(setup.remove);
      yield* statusWhen(setup, (status) => status.phase._tag === "Removing");
      const asked = yield* setup.setUp({ korean: false });
      assert.deepStrictEqual(asked.phase, { _tag: "Removing" });

      yield* Deferred.succeed(gate, undefined);
      const removed = yield* Fiber.join(removal);
      assert.include(removed, { ready: false, onDisk: false });
      assert.deepStrictEqual(removed.phase, { _tag: "Idle" });
    }).pipe(Effect.provide(layer.pipe(Layer.provide(slowRemoval))));
    assert.isFalse(yield* fs.exists(folder));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("on Windows, sets the reader up for DirectML without an NVIDIA GPU", () =>
  Effect.gen(function* () {
    const { layer, folder } = yield* setupServing({ failing: false, windows: true });
    yield* Effect.gen(function* () {
      const setup = yield* ImageReaderSetup.ImageReaderSetup;
      assert.include(yield* statusWhen(setup, () => true), { device: "directml" });
      yield* setup.setUp({ korean: false });
      const done = yield* statusWhen(setup, (status) => status.ready);
      assert.include(done, { device: "directml" });
      const { python } = yield* setup.installation;
      assert.strictEqual(python, `${folder}/venv/Scripts/python.exe`);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("sets the Korean recognizer up with the reader when asked", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { layer } = yield* setupServing({ failing: false });
    yield* Effect.gen(function* () {
      const setup = yield* ImageReaderSetup.ImageReaderSetup;
      const started = yield* setup.setUp({ korean: true });
      assert.include(settingUp(started)?.parts ?? [], "koreanRecognition");
      const done = yield* statusWhen(setup, (status) => status.ready);
      assert.isTrue(done.korean.ready);
      const { models } = yield* setup.installation;
      assert.isTrue(yield* fs.exists(`${models}/korean/ocr_rec.onnx`));
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("adds the Korean recognizer to a reader set up without it, and removes it alone", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { layer, folder } = yield* setupServing({ failing: false });
    yield* Effect.gen(function* () {
      const setup = yield* ImageReaderSetup.ImageReaderSetup;
      yield* setup.setUp({ korean: false });
      const ready = yield* statusWhen(setup, (status) => status.ready);
      assert.isFalse(ready.korean.ready);
      const { models } = yield* setup.installation;
      const general = (yield* fs.readDirectory(models)).toSorted();

      const adding = yield* setup.setUp({ korean: true });
      assert.deepInclude(settingUp(adding), { step: "packages", parts: ["koreanRecognition"] });
      const added = yield* statusWhen(
        setup,
        (status) => status.korean.ready && status.phase._tag === "Idle",
      );
      assert.deepStrictEqual(added.phase, { _tag: "Idle" });
      assert.isTrue(yield* fs.exists(`${models}/korean/ocr_rec.onnx`));
      assert.deepStrictEqual(
        (yield* fs.readDirectory(models)).filter((file) => file !== "korean").toSorted(),
        general,
      );
      const left = yield* fs.readDirectory(folder);
      for (const gone of ["convert-ocr", "cache", "korean.part"]) assert.notInclude(left, gone);
      // Asked again, there is nothing to do.
      assert.strictEqual((yield* setup.setUp({ korean: true })).phase._tag, "Idle");

      const removed = yield* setup.removeKorean;
      assert.include(removed, { ready: true });
      assert.isFalse(removed.korean.ready);
      assert.deepStrictEqual((yield* fs.readDirectory(models)).toSorted(), general);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
