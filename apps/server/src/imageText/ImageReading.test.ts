import { gameFiles, runEnded } from "@rpgtl/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ImageRunStatus, Settings as SavedSettings } from "@rpgtl/contracts";
import { linesPrompt, entryTranslation } from "@rpgtl/domain";
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Catalogs from "../games/Catalogs.ts";
import * as Games from "../games/Games.ts";
import * as LlamaServer from "../localModels/LlamaServer.ts";
import * as RunKinds from "../runs/RunKinds.ts";
import * as Settings from "../settings/Settings.ts";
import { folderWith, mvGame } from "../testUtils/gameFolder.ts";
import {
  encryptedImage,
  FakeReader,
  fakeReader,
  koreanRecognition,
  line,
  nameOf,
  readerModels,
  type ReaderAnswer,
  type ReadRequest,
  testImage,
} from "../testUtils/imageReader.ts";
import { opened, readerNeeds, servicesWith, StateDir } from "../testUtils/state.ts";
import * as ImageReading from "./ImageReading.ts";
import * as VisionModel from "./VisionModel.ts";

/** An answer the fake fallback reader never gives. */
const hangs = Symbol("hangs");

/** The fallback reader's answers, and how many of its starts find too little free memory. */
class FakeVision extends Context.Service<
  FakeVision,
  {
    /** Its answer to `question` about the image named `image`. */
    readonly answer: Ref.Ref<(question: string, image: string) => unknown>;
    readonly memoryShort: Ref.Ref<number>;
  }
>()("@rpgtl/server/imageText/FakeVision") {}

/**
 * The fallback reader as a fake model, whose starts and stops go into the fake image reader's
 * requests, so a test sees the two never hold their models together.
 */
const fakeVision = Layer.unwrap(
  Effect.gen(function* () {
    const { asked } = yield* FakeReader;
    const answer = yield* Ref.make<(question: string, image: string) => unknown>(() => ({
      answer: "lettering",
    }));
    const memoryShort = yield* Ref.make(0);
    const model = yield* LanguageModel.make({
      generateText: Effect.fnUntraced(function* (options) {
        const parts = options.prompt.content.flatMap((message) =>
          message.role === "user" ? message.content : [],
        );
        const question = parts.find((part) => part.type === "text")?.text ?? "";
        const file = parts.find((part) => part.type === "file")?.data;
        const image = file instanceof Uint8Array ? nameOf(file) : "";
        const reply = (yield* Ref.get(answer))(question, image);
        if (reply === hangs) return yield* Effect.never;
        return [{ type: "text", text: JSON.stringify(reply) }];
      }),
      streamText: () => Stream.empty,
    });
    const start: VisionModel.VisionModel["Service"]["start"] = Effect.fnUntraced(
      function* (options) {
        if ((yield* Ref.getAndUpdate(memoryShort, (left) => Math.max(0, left - 1))) > 0)
          return yield* new LlamaServer.NotEnoughMemoryError({
            short: "ram",
            expertLayersInRam: 0,
            needs: { ram: 2 ** 34, vram: 0 },
            free: { ramLimit: 2 ** 33, vram: 0 },
          });
        yield* Ref.update(asked, (all) => [...all, `start ${options.model}`]);
        yield* Effect.addFinalizer(() =>
          Ref.update(asked, (all) => [...all, `stop ${options.model}`]),
        );
        return {
          model: Context.make(LanguageModel.LanguageModel, model),
          ended: Effect.succeedNone,
        };
      },
    );
    return Layer.mergeAll(
      Layer.succeed(VisionModel.VisionModel, VisionModel.VisionModel.of({ start })),
      Layer.succeed(FakeVision, FakeVision.of({ answer, memoryShort })),
    );
  }),
);

const services = ImageReading.layer.pipe(
  Layer.provideMerge(fakeVision),
  Layer.provideMerge(fakeReader),
  Layer.provideMerge(readerNeeds),
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(servicesWith({})),
  Layer.provideMerge(NodeServices.layer),
);

/** Saves the image reading settings that the runs started next read. */
const choose = Effect.fnUntraced(function* (
  images: Partial<SavedSettings["images"]>,
  ollama: Partial<SavedSettings["ollama"]> = {},
) {
  const settings = yield* Settings.Settings;
  const now = yield* settings.get;
  yield* settings.save({
    ...now,
    images: { ...now.images, ...images },
    ollama: { ...now.ollama, ...ollama },
  });
});

/** An MV game with these images below `img/` and this System.json, inspected; gives its id. */
const gameWith = Effect.fnUntraced(function* (
  images: Record<string, Uint8Array>,
  system?: Record<string, unknown>,
) {
  const catalogs = yield* Catalogs.Catalogs;
  const root = yield* folderWith({
    ...mvGame,
    ...(system && { "www/data/System.json": JSON.stringify({ gameTitle: "雨", ...system }) }),
    "www/img/pictures/Title.png": testImage("Title"),
    ...Object.fromEntries(
      Object.entries(images).map(([file, bytes]) => [`www/img/${file}`, bytes]),
    ),
  });
  return (yield* opened(catalogs.inspect(root, "keepBoth"))).game.id;
});

const readsAs = Effect.fnUntraced(function* (
  reads: (request: ReadRequest) => ReaderAnswer | Effect.Effect<ReaderAnswer>,
) {
  const fake = yield* FakeReader;
  yield* Ref.set(fake.reads, (request) => {
    const found = reads(request);
    return Effect.isEffect(found) ? found : Effect.succeed(found);
  });
});

const asked = Effect.gen(function* () {
  const fake = yield* FakeReader;
  return yield* Ref.getAndSet(fake.asked, []);
});

/** The game's run status once `done` holds for it. */
const statusWhen = Effect.fnUntraced(function* (
  id: string,
  done: (status: ImageRunStatus) => boolean = (status) => runEnded(status.phase),
) {
  const reading = yield* ImageReading.ImageReading;
  return yield* Stream.unwrap(reading.changes(id)).pipe(
    Stream.filter(Option.isSome),
    Stream.map((run) => run.value),
    Stream.filter(done),
    Stream.runHead,
    Effect.flatMap(Effect.fromOption),
  );
});

const imageEntries = Effect.fnUntraced(function* (id: string) {
  const catalogs = yield* Catalogs.Catalogs;
  return (yield* catalogs.get(id)).entries
    .filter((entry) => entry.file.startsWith("img/"))
    .map((entry) => `${entry.file} ${entry.source}`);
});

const size = { width: 1120, height: 630 };

it.effect(
  "a run reads each image, small ones enlarged and in strips, and saves entries and erased images",
  () =>
    Effect.gen(function* () {
      const reading = yield* ImageReading.ImageReading;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const id = yield* gameWith({
        "pictures/Notice.png": testImage("Notice"),
        "system/Button.png": testImage("Button"),
        "pictures/Broken.png": new TextEncoder().encode("not an image"),
      });
      yield* readsAs(({ image, scale, crop }) => {
        if (image === "Notice")
          return {
            ...size,
            lines:
              scale === 1
                ? [line("开始游戏")]
                : // Read at twice its size: the same line, and small lettering only it finds.
                  [line("开始游戏"), line("小字提示文本", [100, 500, 300, 520])],
          };
        // A button read only in its lowest strip, alone.
        if (image === "Button")
          return {
            width: 100,
            height: 40,
            lines: crop?.join(",") === "0,24,100,40" ? [line("开始", [10, 25, 90, 39])] : [],
          };
        return { ...size, lines: [] };
      });

      const first = yield* reading.start(id);
      assert.deepInclude(first, { phase: { _tag: "Running" }, done: 0 });
      const last = yield* statusWhen(id);
      assert.deepStrictEqual(last, {
        phase: { _tag: "Finished" },
        total: 4,
        done: 4,
        entries: 3,
        failed: ["img/pictures/Broken"],
        warnings: [],
      });
      assert.deepStrictEqual(yield* imageEntries(id), [
        "img/pictures/Notice 开始游戏",
        "img/pictures/Notice 小字提示文本",
        "img/system/Button 开始",
      ]);
      const requests = yield* asked;
      assert.includeMembers(
        [...requests],
        [
          "read Notice 2",
          "read Button 4",
          "read Button 4 0,24,100,40",
          "prepare Notice",
          "prepare Button",
        ],
      );
      assert.strictEqual(requests.at(-1), "stop");

      const { images } = yield* reading.results(id);
      assert.strictEqual(
        images["img/pictures/Broken"]?.error,
        "Invalid PNG or JPEG image; check encryptionKey in data/System.json.",
      );
      assert.deepStrictEqual(
        images["img/pictures/Notice"]?.lines.map((found) => [found.text, found.enlarged]),
        [
          ["开始游戏", undefined],
          ["小字提示文本", true],
        ],
      );
      const erasedDir = path.join(yield* StateDir, gameFiles(id).erasedImages);
      const erased = images["img/pictures/Notice"]?.erased ?? "";
      assert.deepStrictEqual(
        nameOf(yield* fs.readFile(path.join(erasedDir, erased))),
        "erased Notice",
      );
      // Title has no text, so it has nothing erased.
      assert.lengthOf(yield* fs.readDirectory(erasedDir), 2);

      // Each image read names the run, which keeps the models the reader named.
      const run = images["img/pictures/Notice"]?.run ?? "";
      const { runs } = yield* reading.results(id);
      assert.deepStrictEqual(runs, { [run]: { ...readerModels, includeFaint: false } });
      assert.strictEqual(images["img/system/Button"]?.run, run);
      assert.isUndefined(images["img/pictures/Broken"]?.run);

      // A second run reads only the image that failed, and with nothing read adds no run.
      yield* reading.start(id);
      assert.include(yield* statusWhen(id), { total: 1, done: 1 });
      assert.deepStrictEqual(yield* asked, ["stop"]);
      assert.deepStrictEqual((yield* reading.results(id)).runs, runs);

      // Clearing forgets every read, so the next run reads them all again.
      const cleared = yield* reading.clear(id);
      assert.isFalse(cleared.entries.some((entry) => entry.file.startsWith("img/")));
      assert.deepStrictEqual(yield* reading.results(id), { version: 1, images: {} });
      assert.isFalse(yield* fs.exists(erasedDir));
      assert.isTrue(Option.isNone(yield* reading.status(id)));
      const afterClear = yield* Stream.runHead(Stream.unwrap(reading.changes(id)));
      assert.deepStrictEqual(afterClear, Option.some(Option.none()));
      yield* reading.start(id);
      assert.include(yield* statusWhen(id), { total: 4, entries: 3 });
    }).pipe(Effect.provide(services)),
);

/** The fake reader finds these lines in Notice and none elsewhere. */
const noticeReads = (lines: ReadonlyArray<ReturnType<typeof line>>) =>
  readsAs(({ image }) => ({ ...size, lines: image === "Notice" ? lines : [] }));

it.effect(
  "reading an image again keeps its translations, after a backup, and keeps its result when it fails",
  () =>
    Effect.gen(function* () {
      const reading = yield* ImageReading.ImageReading;
      const catalogs = yield* Catalogs.Catalogs;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const id = yield* gameWith({ "pictures/Notice.png": testImage("Notice") });
      yield* noticeReads([line("开始游戏"), line("退出", [100, 300, 200, 330])]);
      yield* reading.start(id);
      yield* statusWhen(id);
      const read = yield* catalogs.get(id);
      yield* catalogs.write({
        ...read,
        entries: read.entries.map((entry) =>
          entry.source === "开始游戏" ? { ...entry, translation: { user: "Start" } } : entry,
        ),
      });
      const translations = Effect.map(catalogs.get(id), (catalog) =>
        catalog.entries.flatMap((entry) =>
          entry.file.startsWith("img/") ? [[entry.source, entryTranslation(entry)]] : [],
        ),
      );

      // Read again, the line is read differently and gets a new entry with its translation.
      yield* noticeReads([line("开始游戏吧"), line("退出", [100, 300, 200, 330])]);
      yield* reading.start(id, ["img/pictures/Notice"]);
      assert.include(yield* statusWhen(id), { total: 1, done: 1 });
      assert.deepStrictEqual(yield* translations, [
        ["开始游戏吧", "Start"],
        ["退出", ""],
      ]);
      const backups = path.join(yield* StateDir, path.dirname(gameFiles(id).catalog), "backups");
      assert.isNotEmpty(yield* fs.readDirectory(backups));

      // A read again that fails keeps the image's last result and its entries. A score that isn't
      // a number is an answer the reader's schema refuses.
      yield* noticeReads([{ ...line("开始游戏吧"), score: Number.NaN }]);
      yield* reading.start(id, "all");
      const failed = yield* statusWhen(id);
      assert.include(failed, { total: 2 });
      assert.deepStrictEqual(failed.failed, ["img/pictures/Notice"]);
      assert.match(
        failed.warnings[0] ?? "",
        /^img\/pictures\/Notice: .* It keeps what was read before\.$/,
      );
      assert.deepStrictEqual(yield* translations, [
        ["开始游戏吧", "Start"],
        ["退出", ""],
      ]);
    }).pipe(Effect.provide(services)),
);

it.effect("a run with no new images doesn't start the reader", () =>
  Effect.gen(function* () {
    const reading = yield* ImageReading.ImageReading;
    const id = yield* gameWith({ "pictures/Notice.png": testImage("Notice") });
    yield* readsAs(({ image }) =>
      image === "Notice" ? { ...size, lines: [line("开始游戏")] } : { ...size, lines: [] },
    );
    yield* reading.start(id);
    assert.include(yield* statusWhen(id), { entries: 1 });
    yield* asked;

    yield* reading.start(id);
    assert.include(yield* statusWhen(id), { total: 0, entries: 1 });
    assert.deepStrictEqual(yield* asked, []);
  }).pipe(Effect.provide(services)),
);

it.effect("faint lines are left out unless asked for, and taking them in needs no new read", () =>
  Effect.gen(function* () {
    const reading = yield* ImageReading.ImageReading;
    const id = yield* gameWith({ "pictures/Notice.png": testImage("Notice") });
    yield* readsAs(({ image, scale }) =>
      image === "Notice" && scale === 1
        ? {
            ...size,
            lines: [line("开始游戏"), line("水印文字", [100, 300, 400, 330], { contrast: 10 })],
          }
        : { ...size, lines: [] },
    );
    yield* reading.start(id);
    assert.include(yield* statusWhen(id), { entries: 1 });
    yield* asked;

    yield* choose({ includeFaint: true });
    yield* reading.start(id);
    // Title had no text, so it is prepared again too.
    assert.include(yield* statusWhen(id), { total: 2, entries: 2 });
    assert.isFalse((yield* asked).some((request) => request.startsWith("read")));
    assert.deepStrictEqual(yield* imageEntries(id), [
      "img/pictures/Notice 开始游戏",
      "img/pictures/Notice 水印文字",
    ]);
  }).pipe(Effect.provide(services)),
);

// 开 and 始 read apart are a partial read, and 鱼 alone is as often a drawing as lettering.
const partial = {
  width: 1000,
  height: 1000,
  lines: [
    line("开", [100, 100, 130, 130]),
    line("始", [135, 100, 165, 130]),
    line("鱼", [800, 800, 830, 830]),
  ],
};

/** Qwen reads 开始 whole, and takes 鱼 for a drawing. */
const qwenAnswers = (question: string) =>
  question === linesPrompt("chinese")
    ? { lines: [{ text: "开始", bbox_2d: [100, 100, 165, 130] }] }
    : { answer: question.includes('"鱼"') ? "drawing" : "lettering" };

it.effect(
  "the fallback reader drops a line it takes for a drawing and reads a partial line whole",
  () =>
    Effect.gen(function* () {
      const reading = yield* ImageReading.ImageReading;
      const vision = yield* FakeVision;
      const id = yield* gameWith({ "pictures/Notice.png": testImage("Notice") });
      yield* readsAs(({ image, scale, crop }) =>
        image !== "Notice"
          ? { ...size, lines: [] }
          : crop
            ? { width: 1000, height: 1000, lines: [line("开始", [100, 100, 165, 130])] }
            : scale === 1
              ? partial
              : { width: 1000, height: 1000, lines: [] },
      );

      // Without a fallback reader the partial read stays, with a warning.
      yield* reading.start(id);
      assert.deepStrictEqual((yield* statusWhen(id)).warnings, [
        "img/pictures/Notice: Partial image text found. Choose a backup reader to try again.",
      ]);
      assert.deepStrictEqual(yield* imageEntries(id), [
        "img/pictures/Notice 开始",
        "img/pictures/Notice 鱼",
      ]);
      yield* asked;

      yield* Ref.set(vision.answer, qwenAnswers);
      yield* choose({ model: "qwen-vl" });
      yield* reading.start(id);
      const last = yield* statusWhen(id);
      assert.include(last, { total: 1, done: 1, entries: 1 });
      assert.deepStrictEqual(last.warnings, []);
      assert.deepStrictEqual(yield* imageEntries(id), ["img/pictures/Notice 开始"]);
      const { images } = yield* reading.results(id);
      assert.include(images["img/pictures/Notice"], { fallback: "qwen-vl" });
      // The saved lines go to the fallback reader without a new read, and the image reader, with
      // no new image to read first, starts only after the fallback reader stopped.
      assert.deepStrictEqual(yield* asked, [
        "start qwen-vl",
        "flatten Notice 40,40,190,190",
        "flatten Notice 75,40,225,190",
        "flatten Notice 740,740,890,890",
        "flatten Notice",
        "stop qwen-vl",
        "read Notice 2 68,68,197,162",
        "prepare Notice",
        "stop",
      ]);

      // Taking faint lines in prepares the image again, still as the fallback reader read it.
      yield* choose({ includeFaint: true });
      yield* reading.start(id);
      assert.deepStrictEqual((yield* statusWhen(id)).warnings, []);
      assert.include((yield* reading.results(id)).images["img/pictures/Notice"], {
        fallback: "qwen-vl",
        includeFaint: true,
      });
      assert.isFalse((yield* asked).some((request) => request.startsWith("read")));
    }).pipe(Effect.provide(services)),
);

it.effect("the fallback reader waits until its model fits in free memory, as its loading", () =>
  Effect.gen(function* () {
    const reading = yield* ImageReading.ImageReading;
    const vision = yield* FakeVision;
    const id = yield* gameWith({ "pictures/Notice.png": testImage("Notice") });
    yield* readsAs(({ image, scale }) =>
      image === "Notice" && scale === 1 ? partial : { ...size, lines: [] },
    );
    yield* Ref.set(vision.answer, qwenAnswers);
    yield* Ref.set(vision.memoryShort, 2);
    yield* choose({ model: "qwen-vl" });
    yield* reading.start(id);
    const waiting = yield* statusWhen(
      id,
      ({ phase }) => phase._tag === "Running" && phase.fallback?.waiting !== undefined,
    );
    assert.strictEqual(waiting.phase._tag, "Running");
    if (waiting.phase._tag !== "Running") return;
    assert.match(waiting.phase.fallback?.waiting ?? "", /Waiting until it fits\.$/);
    assert.strictEqual(waiting.phase.loading, "backupReader");
    yield* TestClock.adjust("5 seconds");
    yield* TestClock.adjust("5 seconds");
    const last = yield* statusWhen(id);
    assert.deepInclude(last, { phase: { _tag: "Finished" }, total: 2, done: 2 });
    assert.include((yield* reading.results(id)).images["img/pictures/Notice"], {
      fallback: "qwen-vl",
    });
  }).pipe(Effect.provide(services)),
);

it.effect(
  "a run fails when the reader is down, holds its game until stopped, and goes on from there",
  () =>
    Effect.gen(function* () {
      const reading = yield* ImageReading.ImageReading;
      const fake = yield* FakeReader;
      const games = yield* Games.Games;
      const runKinds = yield* RunKinds.RunKinds;
      const id = yield* gameWith({ "pictures/Notice.png": testImage("Notice") });

      yield* Ref.set(fake.up, false);
      yield* reading.start(id);
      const failed = (yield* statusWhen(id)).phase;
      assert.match(
        failed._tag === "Failed" ? failed.error : "",
        /stopped while starting\. See \/cache\/rpgtl\/image-reader\/reader\.log for why\./,
      );
      yield* Ref.set(fake.up, true);

      const never = yield* Deferred.make<ReaderAnswer>();
      yield* readsAs(({ image }) =>
        image === "Title" ? Deferred.await(never) : { ...size, lines: [line("开始游戏")] },
      );
      yield* reading.start(id);
      yield* statusWhen(id, (status) => status.done === 1);
      assert.strictEqual((yield* Effect.flip(reading.start(id)))._tag, "GameBusyError");
      const translation = yield* Effect.scoped(
        Effect.flatMap(
          runKinds.translation({ id: "harbor", title: "Harbor Tales" }, { local: false }),
          (turn) => turn.waitingFor,
        ),
      );
      assert.deepStrictEqual(translation, [{ kind: "imageReading", game: { id, title: "雨" } }]);
      const stopped = yield* reading.stop(id);
      assert.isTrue(Option.isSome(stopped));
      assert.deepInclude(Option.getOrThrow(stopped), { phase: { _tag: "Stopped" }, done: 1 });
      yield* Effect.scoped(games.hold(id));

      yield* readsAs(() => ({ ...size, lines: [line("标题")] }));
      yield* reading.start(id);
      assert.include(yield* statusWhen(id), { total: 1, done: 1, entries: 2 });
    }).pipe(Effect.provide(services)),
);

it.effect(
  "images are read in one game at a time: another game's reading waits, named in English, and can be stopped while it does",
  () =>
    Effect.gen(function* () {
      const reading = yield* ImageReading.ImageReading;
      const catalogs = yield* Catalogs.Catalogs;
      const games = yield* Games.Games;
      const first = yield* gameWith({}, {});
      const catalog = yield* catalogs.get(first);
      yield* catalogs.save({
        ...catalog,
        entries: catalog.entries.map((entry) =>
          entry.file === "System.json" && entry.path[0] === "gameTitle"
            ? { ...entry, translation: { user: "Rain" } }
            : entry,
        ),
      });
      const second = yield* gameWith({});
      const third = yield* gameWith({});

      const never = yield* Deferred.make<ReaderAnswer>();
      yield* readsAs(() => Deferred.await(never));
      yield* reading.start(first);
      const waiting = yield* reading.start(second);
      assert.deepStrictEqual(waiting.phase, {
        _tag: "Waiting",
        for: [{ kind: "imageReading", game: { id: first, title: "Rain" } }],
      });
      // A waiting game isn't held, but stays listed and keeps its image text.
      yield* Effect.scoped(games.hold(second));
      assert.strictEqual((yield* Effect.flip(reading.clear(second)))._tag, "GameBusyError");
      assert.strictEqual((yield* Effect.flip(games.forget(second)))._tag, "GameBusyError");
      yield* reading.start(third);
      assert.deepInclude(Option.getOrThrow(yield* reading.stop(third)), {
        phase: { _tag: "Stopped" },
      });

      yield* readsAs(() => ({ ...size, lines: [line("标题")] }));
      yield* reading.stop(first);
      assert.deepInclude(yield* statusWhen(second), { done: 1, phase: { _tag: "Finished" } });
    }).pipe(Effect.provide(services)),
);

it.effect("a reading whose turn comes while its game is held fails, saying so", () =>
  Effect.gen(function* () {
    const reading = yield* ImageReading.ImageReading;
    const games = yield* Games.Games;
    const first = yield* gameWith({});
    const second = yield* gameWith({});
    const never = yield* Deferred.make<ReaderAnswer>();
    yield* readsAs(() => Deferred.await(never));
    yield* reading.start(first);
    yield* reading.start(second);

    const held = yield* Effect.scoped(
      Effect.andThen(games.hold(second), Effect.andThen(reading.stop(first), statusWhen(second))),
    );
    assert.deepStrictEqual(held.phase, {
      _tag: "Failed",
      error:
        "Another operation holds this game, such as an import. Try again once it has finished.",
    });
  }).pipe(Effect.provide(services)),
);

it.effect("an Ollama endpoint on another computer fails the run", () =>
  Effect.gen(function* () {
    const reading = yield* ImageReading.ImageReading;
    const id = yield* gameWith({});
    yield* choose({}, { endpoint: "http://example.com:11434" });
    yield* reading.start(id);
    assert.deepStrictEqual((yield* statusWhen(id)).phase, {
      _tag: "Failed",
      error: "Translation endpoints must be on this computer (127.0.0.1, localhost, or ::1).",
    });
  }).pipe(Effect.provide(services)),
);

it.effect("encrypted images are read with System.json's key, and without it they fail", () =>
  Effect.gen(function* () {
    const reading = yield* ImageReading.ImageReading;
    const key = "0123456789abcdef0123456789abcdef";
    // Long enough for its encryption header and the 16 bytes it encrypts.
    const notice = {
      "pictures/Notice.rpgmvp": encryptedImage(testImage("Encrypted notice"), key),
    };
    yield* readsAs(({ image }) =>
      image === "Encrypted notice"
        ? { ...size, lines: [line("开始游戏")] }
        : { ...size, lines: [] },
    );
    const id = yield* gameWith(notice, { hasEncryptedImages: true, encryptionKey: key });
    yield* reading.start(id);
    assert.include(yield* statusWhen(id), { total: 1, entries: 1 });
    assert.deepStrictEqual((yield* statusWhen(id)).failed, []);

    const keyless = yield* gameWith(notice, { hasEncryptedImages: true });
    yield* reading.start(keyless);
    assert.deepStrictEqual((yield* statusWhen(keyless)).failed, ["img/pictures/Notice"]);
    assert.strictEqual(
      (yield* reading.results(keyless)).images["img/pictures/Notice"]?.error,
      "Missing or invalid encryptionKey in data/System.json.",
    );
  }).pipe(Effect.provide(services)),
);

it.effect(
  "a fallback reader that doesn't answer in 5 minutes is asked nothing more, and the run goes on",
  () =>
    Effect.gen(function* () {
      const reading = yield* ImageReading.ImageReading;
      const vision = yield* FakeVision;
      const id = yield* gameWith({
        "pictures/Notice.png": testImage("Notice"),
        "pictures/Sign.png": testImage("Sign"),
      });
      yield* readsAs(({ image, scale }) =>
        image !== "Title" && scale === 1 ? partial : { ...size, lines: [] },
      );
      yield* Ref.set(vision.answer, () => hangs);
      yield* choose({ model: "qwen-vl" });
      yield* reading.start(id);
      // Each request starts its 5 minutes when it is sent, so the clock moves on until the run ends.
      const last = yield* statusWhen(id).pipe(
        Effect.raceFirst(
          Effect.forever(
            TestClock.adjust("1 minute").pipe(
              Effect.andThen(TestClock.withLive(Effect.sleep("5 millis"))),
            ),
          ),
        ),
      );
      assert.deepStrictEqual(last.warnings, [
        "img/pictures/Notice: Backup reader: It didn't answer within 5 minutes.",
        "Backup reader: It stopped answering, so the rest of the images keep the image reader's lines.",
      ]);
      assert.include(last, { done: 3, entries: 4 });
    }).pipe(Effect.provide(services)),
);

it.effect(
  "a Korean game's images are read with the Korean recognizer, and without it the run says so",
  () =>
    Effect.gen(function* () {
      const reading = yield* ImageReading.ImageReading;
      const catalogs = yield* Catalogs.Catalogs;
      const fake = yield* FakeReader;
      const id = yield* gameWith({ "pictures/Notice.png": testImage("Notice") });
      yield* catalogs.setLanguage(id, "korean");
      const languages: Array<string> = [];
      yield* readsAs(({ image, language }) => {
        languages.push(language);
        return image === "Notice"
          ? { ...size, lines: [line("모험 시작")] }
          : { ...size, lines: [] };
      });

      yield* reading.start(id);
      const failed = (yield* statusWhen(id)).phase;
      assert.include(failed._tag === "Failed" ? failed.error : "", "needs the Korean text model");
      assert.deepStrictEqual(languages, []);

      yield* Ref.set(fake.korean, true);
      yield* reading.start(id);
      assert.include(yield* statusWhen(id), { entries: 1 });
      assert.isAbove(languages.length, 0);
      assert.isTrue(languages.every((language) => language === "korean"));
      const runs = Object.values((yield* reading.results(id)).runs ?? {});
      assert.deepStrictEqual(
        runs.map((run) => run.recognition),
        [koreanRecognition],
      );
    }).pipe(Effect.provide(services)),
);
