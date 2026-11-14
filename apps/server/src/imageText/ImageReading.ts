import type {
  Catalog,
  ExportedImageText,
  Game,
  ImageLine,
  ImageReadingSettings,
  ReadAgain,
  ImageReadResults,
  ImageResult,
  ImageRun,
  ImageRunStatus,
} from "@rpgtl/contracts";
import { gameFiles, imageReadingSettings } from "@rpgtl/contracts";
import {
  blocksPrepared,
  contrastVersion,
  decryptImage,
  doubtfulLines,
  type GameImage,
  gameLanguage,
  type ImageFileProblem,
  imageBlocks,
  imageEntries,
  imageHash,
  type ImagePlan,
  imagePlan,
  type ImageRead,
  localEndpoint,
  mergeQwenLines,
  needsFallback,
  partialRead,
  preparedVersion,
  qwenCrops,
  readResults,
  readVersion,
  withImageEntries,
  isImageText,
} from "@rpgtl/domain";
import * as AiError from "effect/ai/AiError";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Catalogs from "../games/Catalogs.ts";
import * as GameFolder from "../games/GameFolder.ts";
import * as Games from "../games/Games.ts";
import { endedPhase } from "../runs/endedPhase.ts";
import * as RunKinds from "../runs/RunKinds.ts";
import * as Settings from "../settings/Settings.ts";
import * as StateFolder from "../state/StateFolder.ts";
import { EndpointRejectedError } from "../translation/translators.ts";
import * as ImageReader from "./ImageReader.ts";
import { exportedImageText } from "./exportedImages.ts";
import * as ImageTexts from "./ImageTexts.ts";
import { drawnLines, fallbackLines, readGameImage } from "./reading.ts";
import * as VisionModel from "./VisionModel.ts";

/** An image file that isn't a picture RPGTL can read. */
class ImageFileError extends Schema.TaggedError<ImageFileError>()("ImageFileError", {
  problem: Schema.Literals(["encryptionKey", "notAnImage"]),
}) {
  override get message() {
    return this.problem === "encryptionKey"
      ? "Missing or invalid encryptionKey in data/System.json."
      : "Invalid PNG or JPEG image; check encryptionKey in data/System.json.";
  }
}

/** An image of the game with its file's bytes and what the run does with it. */
interface PlannedImage extends GameImage {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly plan: ImagePlan;
}

/** An image the fallback reader reads, with the image reader's lines of it. */
interface PartlyRead extends PlannedImage {
  readonly read: ImageRead;
}

/** What reading an image found, and the fallback reader whose lines are among them. */
type Found = ImageRead & { readonly fallback?: string };

type Running = Extract<ImageRunStatus["phase"], { readonly _tag: "Running" }>;

/** What the fallback reader found in an image: lines it took for drawings, and its own lines. */
interface FallbackAnswer {
  readonly drawn: ReadonlyArray<ImageLine>;
  readonly lines: Option.Option<ReadonlyArray<ImageLine>>;
}

const unexpected = "Image reading stopped on an unexpected error. RPGTL's log says more.";

// Their messages say what to do, such as starting the image reader.
const shownErrors = new Set([
  "ImageReaderError",
  "ImageReaderMissingError",
  "GameFileMissingError",
  "GameFileReadError",
  "GameFileInvalid",
  "EndpointRejectedError",
  "GameBusyError",
]);

/** What the page shows when a run ends early, from what ended it. */
const runFailure = (cause: Cause.Cause<unknown>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => unexpected,
    onSome: (error) =>
      StateFolder.isStateFileError(error)
        ? `Couldn't ${error.operation} ${error.file}.`
        : error instanceof Error &&
            Predicate.hasProperty(error, "_tag") &&
            shownErrors.has(String(error._tag))
          ? error.message
          : unexpected,
  });

/** A failure of the fallback reader as the run's warnings name it. */
const fallbackFailure = (
  error: AiError.AiError | ImageReader.ReaderFailure | ImageFileError | Cause.TimeoutError,
) => {
  if (Cause.isTimeoutError(error)) return "It didn't answer within 5 minutes.";
  if (!AiError.isAiError(error)) return error.message;
  switch (error.reason._tag) {
    case "NetworkError":
      return "Could not reach llama-server.";
    case "StructuredOutputError":
    case "InvalidOutputError":
      return "Its answer didn't fit the format it was asked for.";
    default:
      return "Its request failed. RPGTL's log says why.";
  }
};

/**
 * Reading the text in games' images, one run per game at a time, each a fiber that `stop`
 * interrupts. A run holds its game and never runs beside a translation run. It reads the images
 * with the image reader, and the ones it read only partly with the fallback reader, then saves
 * their read results and image text entries after each image.
 */
export class ImageReading extends Context.Service<
  ImageReading,
  {
    /** What the image reader found in the game's images; empty before any reading. */
    readonly results: (
      id: string,
    ) => Effect.Effect<ImageReadResults, Games.GameNotInspectedError | StateFolder.StateFileError>;
    /** The read results and erased backgrounds a translation file carries; none without any. */
    readonly exported: (
      id: string,
    ) => Effect.Effect<
      Option.Option<ExportedImageText>,
      Games.GameNotInspectedError | StateFolder.StateFileError
    >;
    /** The game's current or last run since RPGTL started. */
    readonly status: (
      id: string,
    ) => Effect.Effect<Option.Option<ImageRunStatus>, Games.GameNotInspectedError>;
    /**
     * The game's current or last run, none before its first since RPGTL started or its last clear,
     * then each change to it and each later run, until the stream is closed.
     */
    readonly changes: (
      id: string,
    ) => Effect.Effect<Stream.Stream<Option.Option<ImageRunStatus>>, Games.GameNotInspectedError>;
    /**
     * Starts reading the game's images that changed or aren't read yet, and those in `again` from
     * scratch, with the saved settings once the reading's turn comes, and gives its first status.
     * Fails while the game's last reading hasn't ended.
     */
    readonly start: (
      id: string,
      again?: ReadAgain,
    ) => Effect.Effect<
      ImageRunStatus,
      | Games.GameNotInspectedError
      | Games.GameBusyError
      | RunKinds.ReaderRemovingError
      | StateFolder.StateFileError
    >;
    /** Stops the game's run, keeping what it saved, and gives its status once it has ended. */
    readonly stop: (
      id: string,
    ) => Effect.Effect<Option.Option<ImageRunStatus>, Games.GameNotInspectedError>;
    /**
     * Deletes the game's read results, erased backgrounds and image text entries, and forgets
     * its last run, holding the game while it does. Fails while a reading of the game waits or
     * runs.
     */
    readonly clear: (
      id: string,
    ) => Effect.Effect<
      Catalog,
      Games.GameNotInspectedError | Games.GameBusyError | StateFolder.StateFileError
    >;
  }
>()("@rpgtl/server/imageText/ImageReading") {}

const make = Effect.gen(function* () {
  const games = yield* Games.Games;
  const catalogs = yield* Catalogs.Catalogs;
  const imageTexts = yield* ImageTexts.ImageTexts;
  const gameFolder = yield* GameFolder.GameFolder;
  const reader = yield* ImageReader.ImageReader;
  const visionModel = yield* VisionModel.VisionModel;
  const runKinds = yield* RunKinds.RunKinds;
  const savedSettings = yield* Settings.Settings;
  const folder = yield* StateFolder.StateFolder;
  const fibers = yield* FiberMap.make<string>();
  // A reading that waits holds nothing between the check for a reading of its game and its
  // fiber's start, so starts go one at a time.
  const starts = yield* Semaphore.make(1);
  const statuses = yield* SubscriptionRef.make(
    new Map<string, SubscriptionRef.SubscriptionRef<ImageRunStatus>>(),
  );

  const results = Effect.fn("ImageReading.results")(function* (id: string) {
    yield* games.get(id);
    return yield* imageTexts.results(id);
  });
  const exported = Effect.fn("ImageReading.exported")(function* (id: string) {
    const game = yield* games.get(id);
    const files = yield* imageTexts.exported(id);
    if (Option.isNone(files)) return Option.none<ExportedImageText>();
    return yield* exportedImageText(game, files.value).pipe(
      Effect.provideService(GameFolder.GameFolder, gameFolder),
    );
  });

  const status = Effect.fn("ImageReading.status")(function* (id: string) {
    yield* games.get(id);
    const current = (yield* SubscriptionRef.get(statuses)).get(id);
    return current === undefined
      ? Option.none<ImageRunStatus>()
      : Option.some(yield* SubscriptionRef.get(current));
  });

  const changes = Effect.fn("ImageReading.changes")(function* (id: string) {
    yield* games.get(id);
    return SubscriptionRef.changes(statuses).pipe(
      Stream.map((runs) => runs.get(id)),
      Stream.changesWith((a, b) => a === b),
      Stream.switchMap((current) =>
        current === undefined
          ? Stream.make(Option.none<ImageRunStatus>())
          : Stream.map(SubscriptionRef.changes(current), Option.some),
      ),
    );
  });

  /** The run itself, from the game's images to its last saved result. */
  const run = Effect.fn("ImageReading.run")(function* (
    game: Game,
    settings: ImageReadingSettings,
    ollama: URL,
    current: SubscriptionRef.SubscriptionRef<ImageRunStatus>,
    again: ReadAgain | undefined,
  ) {
    const id = game.id;
    const fallbackModel = settings.fallbackModel?.trim() ?? "";
    const update = (change: (now: ImageRunStatus) => ImageRunStatus) =>
      SubscriptionRef.update(current, change);
    const warn = (message: string) =>
      update((now) => ({ ...now, warnings: [...now.warnings, message] }));
    const whileRunning = (change: (now: Running) => Running) =>
      update((now) => (now.phase._tag === "Running" ? { ...now, phase: change(now.phase) } : now));
    const loading = <A, E, R>(
      which: NonNullable<Running["loading"]>,
      effect: Effect.Effect<A, E, R>,
    ) =>
      whileRunning((now) => ({ ...now, loading: which })).pipe(
        Effect.andThen(effect),
        Effect.ensuring(whileRunning((now) => Struct.omit(now, ["loading"]))),
      );

    const language = gameLanguage(yield* catalogs.get(id));
    const { images, key } = yield* gameFolder.textImages(game);
    const listed = new Set(images.map((image) => image.image));
    const savedResults = yield* imageTexts.results(id);
    const saved = Object.fromEntries(
      Object.entries(savedResults.images).filter(([image]) => listed.has(image)),
    );
    const runStart = DateTime.formatIso(yield* DateTime.now);
    const runs: Record<string, ImageRun> = { ...savedResults.runs };
    // Asked once the reader is needed, which is when the run reads or erases its first image. A
    // failed ask is tried again with the next image.
    const thisRun = yield* Effect.cachedWithTTL(
      Effect.map(reader.models(language), (models) => {
        runs[runStart] = {
          ...models,
          ...(fallbackModel && { backupReader: fallbackModel }),
          includeFaint: settings.includeFaint,
        };
      }),
      (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    );
    const read: { readonly version: 1; images: Record<string, ImageResult> } = {
      version: 1,
      images: saved,
    };
    // The results the catalog's image entries were read from, as `read` changes during the run.
    const before = { version: 1 as const, images: { ...saved } };
    // However the run ends, erased backgrounds no result uses go, and the reader frees its models.
    yield* Effect.addFinalizer(() =>
      imageTexts.removeUnused(id).pipe(
        Effect.andThen(reader.stop.pipe(Effect.timeout(Duration.minutes(1)))),
        // oxlint-disable-next-line rpgtl/no-catch-all -- cleanup after the run, which has ended either way
        Effect.catchCause((cause) => Effect.logWarning("Cleaning up image reading failed.", cause)),
      ),
    );

    const planned = yield* Effect.forEach(images, (image) =>
      Effect.map(gameFolder.readFile(game, image.file), (bytes): PlannedImage => {
        const sha256 = imageHash(bytes);
        const plan =
          again === "all" || again?.includes(image.image)
            ? "read"
            : imagePlan(image.image, read.images[image.image], {
                sha256,
                includeFaint: settings.includeFaint,
                fallback: fallbackModel !== "",
              });
        return { ...image, bytes, sha256, plan };
      }),
    );
    const pending = planned.filter((image) => image.plan === "read" || image.plan === "again");
    // Images read only partly, or with doubtful lines, wait for the fallback reader until every
    // other image is read, so all entries show up early and its model loads only at the end.
    const partial: Array<PartlyRead> = planned.flatMap((image) => {
      const result = read.images[image.image];
      return image.plan === "fallback" && result ? [{ ...image, read: result }] : [];
    });
    yield* update((now) => ({ ...now, total: pending.length + partial.length }));
    // The reader would start with the first read anyway; starting it here fails early, also when
    // it has no recognizer for the game's language, and only when there is something to read, as
    // loading its models takes a while.
    if (pending.length > 0) yield* loading("imageReader", Effect.andThen(reader.start, thisRun));

    // Most images give no entries, and rewriting a large catalog for each of them can take as long as
    // reading the image, so the catalog is written only when the image entries change.
    let writtenEntries: string | undefined;
    const save = Effect.gen(function* () {
      const entryIds = imageEntries(read)
        .map((entry) => entry.id)
        .join();
      if (entryIds === writtenEntries)
        return yield* imageTexts.save(id, readResults(read.images, runs));
      const next = withImageEntries(yield* catalogs.get(id), read, before);
      yield* imageTexts.save(id, readResults(read.images, runs));
      yield* catalogs.write(next);
      writtenEntries = entryIds;
      const entries = next.entries.filter(isImageText).length;
      yield* update((now) => ({ ...now, entries }));
    }).pipe(Effect.uninterruptible);

    const decrypted = (image: PlannedImage) =>
      Effect.fromResult(
        Result.mapError(
          decryptImage(image.bytes, Option.getOrUndefined(key)),
          (problem: ImageFileProblem) => new ImageFileError({ problem }),
        ),
      );

    /**
     * Reads one image with `readImage`, prepares it for drawing and saves it with its erased
     * background, or as failed. An image `readImage` leaves for later is saved with its lines
     * only and doesn't count as done. Untraced: it runs for each image, inside the run's span.
     */
    const finish = Effect.fnUntraced(function* (
      image: PlannedImage,
      readImage: (
        bytes: Uint8Array,
      ) => Effect.Effect<Option.Option<Found>, ImageReader.ReaderFailure>,
    ) {
      const outcome = yield* Effect.gen(function* () {
        const bytes = yield* decrypted(image);
        const found = yield* readImage(bytes);
        if (Option.isNone(found)) return false;
        const { width, height, lines } = yield* reader.measure(bytes, found.value);
        const { fallback } = found.value;
        const measured = {
          width,
          height,
          lines,
          ...(fallback !== undefined && { fallback }),
          includeFaint: settings.includeFaint,
          contrastVersion,
        };
        const blocks = imageBlocks(measured);
        const previous = read.images[image.image];
        const reused =
          previous?.sha256 === image.sha256 &&
          JSON.stringify(previous.lines) === JSON.stringify(measured.lines) &&
          blocksPrepared(previous, blocks);
        const prepared =
          blocks.length > 0 && !reused
            ? Option.some(yield* reader.prepare(bytes, measured.lines, blocks, language))
            : Option.none();
        const erased = Option.isSome(prepared)
          ? Option.some(yield* imageTexts.saveErased(id, prepared.value.erased))
          : Option.fromUndefinedOr(reused ? previous?.erased : undefined);
        yield* thisRun;
        read.images[image.image] = {
          ...measured,
          file: image.file,
          sha256: image.sha256,
          readVersion,
          preparedVersion,
          run: runStart,
          blocks: Option.isSome(prepared)
            ? prepared.value.blocks
            : reused && previous?.blocks
              ? previous.blocks
              : [],
          ...(Option.isSome(erased) && { erased: erased.value }),
        };
        return true;
      }).pipe(
        Effect.map((done) => Result.succeed(done)),
        Effect.catchTags({
          ImageFileError: (error) => Effect.succeed(Result.fail(error.message)),
          ImageReaderError: (error) => Effect.succeed(Result.fail(error.message)),
          ImageReaderMissingError: (error) => Effect.succeed(Result.fail(error.message)),
        }),
      );
      // An image that fails again keeps what was read from the same file before.
      const kept = before.images[image.image];
      if (Result.isFailure(outcome)) {
        if (kept?.sha256 === image.sha256 && kept.error === undefined) {
          read.images[image.image] = kept;
          yield* warn(`${image.image}: ${outcome.failure} It keeps what was read before.`);
        } else
          read.images[image.image] = {
            file: image.file,
            sha256: image.sha256,
            width: 0,
            height: 0,
            lines: [],
            error: outcome.failure,
          };
        yield* update((now) => ({ ...now, failed: [...now.failed, image.image] }));
      }
      yield* save;
      if (Result.isFailure(outcome) || outcome.success)
        yield* update((now) => ({ ...now, done: now.done + 1 }));
    });

    // The run starts from a backup of the catalog as it was.
    const catalog = yield* catalogs.get(id);
    yield* catalogs.save(catalog);
    yield* save;
    for (const image of pending)
      yield* finish(image, (bytes) =>
        Effect.gen(function* () {
          const previous = read.images[image.image];
          const found =
            image.plan === "again" && previous ? previous : yield* readGameImage(bytes, language);
          const { width, height, lines } = yield* reader.measure(bytes, found);
          const measured = { width, height, lines, includeFaint: settings.includeFaint };
          // Lines the fallback reader already read stay its own.
          if (found === previous && previous.fallback !== undefined)
            return Option.some({ ...measured, fallback: previous.fallback });
          if (!needsFallback(image.image, measured)) return Option.some(measured);
          if (fallbackModel) {
            // Saved without blocks, so a stopped run gives it to the fallback reader next time.
            read.images[image.image] = {
              ...measured,
              contrastVersion,
              file: image.file,
              sha256: image.sha256,
              readVersion,
            };
            partial.push({ ...image, read: measured });
            return Option.none();
          }
          if (partialRead(measured))
            yield* warn(
              `${image.image}: Partial image text found. Choose a backup reader to try again.`,
            );
          return Option.some(measured);
        }).pipe(Effect.provideService(ImageReader.ImageReader, reader)),
      );
    if (partial.length === 0) return;

    // The fallback reader reads every partly read image first, and the image reader prepares
    // them after the fallback reader's model is gone, so their models are never in memory
    // together.
    yield* reader.stop;
    yield* whileRunning((now) => ({ ...now, fallback: { done: 0, total: partial.length } }));
    const answers = yield* Effect.scoped(
      Effect.gen(function* () {
        const started = yield* loading(
          "backupReader",
          visionModel
            .start({
              endpoint: ollama,
              model: fallbackModel,
              ...(settings.expertLayersInRam !== undefined && {
                expertLayersInRam: settings.expertLayersInRam,
              }),
              log: `${folder.root}/${gameFiles(id).logs}/image-llama-server.log`,
            })
            .pipe(
              // It waits until the model fits in free memory instead of failing.
              Effect.tapErrorTag("NotEnoughMemoryError", (error) =>
                whileRunning((now) => ({
                  ...now,
                  ...(now.fallback && {
                    fallback: {
                      ...now.fallback,
                      waiting: `${error.message} Waiting until it fits.`,
                    },
                  }),
                })),
              ),
              Effect.retry({
                while: (error) => error._tag === "NotEnoughMemoryError",
                schedule: Schedule.spaced(Duration.seconds(5)),
              }),
              Effect.tapError((error) =>
                error._tag === "PlatformError"
                  ? Effect.logWarning("The backup reader didn't start.", error)
                  : Effect.void,
              ),
              Effect.result,
            ),
        );
        yield* whileRunning((now) => ({
          ...now,
          ...(now.fallback && { fallback: Struct.omit(now.fallback, ["waiting"]) }),
        }));
        const found = new Map<string, FallbackAnswer>();
        if (Result.isFailure(started)) {
          yield* warn(
            `Backup reader: ${started.failure._tag === "PlatformError" ? "llama-server didn't start. RPGTL's log says why." : started.failure.message}`,
          );
          return found;
        }
        const { model, ended } = started.success;
        for (const image of partial) {
          const answer = yield* Effect.gen(function* () {
            const bytes = yield* decrypted(image);
            const drawn = yield* drawnLines(bytes, doubtfulLines(image.image, image.read));
            const rest = image.read.lines.filter((line) => !drawn.includes(line));
            const lines = partialRead({ ...image.read, lines: rest })
              ? Option.some(yield* fallbackLines(bytes, image.read, language))
              : Option.none();
            return { drawn, lines } satisfies FallbackAnswer;
          }).pipe(
            Effect.provideContext(model),
            Effect.provideService(ImageReader.ImageReader, reader),
            Effect.result,
          );
          if (Result.isSuccess(answer)) found.set(image.image, answer.success);
          else {
            const gone = yield* ended;
            if (Option.isSome(gone)) {
              yield* warn(`Backup reader: ${gone.value.message}`);
              break;
            }
            yield* Effect.logWarning("The backup reader failed on an image.", answer.failure);
            yield* warn(`${image.image}: Backup reader: ${fallbackFailure(answer.failure)}`);
            // A llama-server that hangs without ending would cost 5 minutes for each request left.
            if (Cause.isTimeoutError(answer.failure)) {
              yield* warn(
                "Backup reader: It stopped answering, so the rest of the images keep the image reader's lines.",
              );
              break;
            }
          }
          yield* whileRunning((now) => ({
            ...now,
            ...(now.fallback && { fallback: { ...now.fallback, done: now.fallback.done + 1 } }),
          }));
        }
        return found;
      }),
    );
    yield* whileRunning((now) => Struct.omit(now, ["fallback"]));
    // Started here to show its loading; an image it fails on says why.
    yield* loading(
      "imageReader",
      reader.start.pipe(
        Effect.catchTags({
          ImageReaderError: () => Effect.void,
          ImageReaderMissingError: () => Effect.void,
        }),
      ),
    );

    for (const image of partial)
      yield* finish(image, (bytes) =>
        Effect.gen(function* () {
          const answer = answers.get(image.image);
          if (!answer) return Option.some(image.read);
          const kept = {
            ...image.read,
            lines: image.read.lines.filter((line) => !answer.drawn.includes(line)),
          };
          if (Option.isNone(answer.lines)) return Option.some({ ...kept, fallback: fallbackModel });
          const fallback = answer.lines.value;
          // The image reader reads each line only the fallback reader found again in a crop,
          // for an exact outline; without those reads the image keeps the image reader's lines.
          const crops = yield* Effect.forEach(qwenCrops(kept, fallback), ({ index, crop }) =>
            Effect.map(
              reader.read(bytes, { language, crop, scale: 2 }),
              (cropRead) => [index, cropRead] as const,
            ),
          ).pipe(Effect.result);
          if (Result.isFailure(crops)) {
            yield* warn(`${image.image}: Backup reader: ${crops.failure.message}`);
            return Option.some(kept);
          }
          return Option.some({
            ...mergeQwenLines(kept, fallback, new Map(crops.success)),
            fallback: fallbackModel,
          });
        }),
      );
  });

  /** Ends the run's status with how it ended. */
  const end = Effect.fn("ImageReading.end")(function* (
    current: SubscriptionRef.SubscriptionRef<ImageRunStatus>,
    exit: Exit.Exit<unknown, unknown>,
  ) {
    const phase = endedPhase(exit, runFailure);
    if (Exit.isFailure(exit) && phase._tag === "Failed")
      yield* Effect.logWarning("Image reading failed.", exit.cause);
    yield* SubscriptionRef.update(current, (last) => ({ ...last, phase }));
  });

  /** Reads the held game's images with `settings`. */
  const read = Effect.fn("ImageReading.read")(function* (
    game: Game,
    settings: ImageReadingSettings,
    current: SubscriptionRef.SubscriptionRef<ImageRunStatus>,
    again: ReadAgain | undefined,
  ) {
    const ollama = yield* Effect.fromResult(
      Result.mapError(
        localEndpoint(settings.ollamaEndpoint),
        (problem) => new EndpointRejectedError({ problem }),
      ),
    );
    yield* run(game, settings, ollama, current, again);
  });

  const start = Effect.fn("ImageReading.start")(function* (id: string, again?: ReadAgain) {
    const game = yield* games.get(id);
    if (yield* FiberMap.has(fibers, id)) return yield* new Games.GameBusyError({ id });
    const listed = (yield* catalogs.list).find((each) => each.id === id);
    const settings = imageReadingSettings(yield* savedSettings.get);
    // The run's scope keeps the game listed and the run's place in the queue, then holds the game
    // until the run ends.
    const scope = yield* Scope.make();
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* games.keep(id);
        const turn = yield* runKinds.imageReading({
          id,
          title: listed?.titleTranslation ?? game.title,
        });
        const waitingFor = yield* turn.waitingFor;
        // A run whose turn has come holds the game before the answer, so a game held by
        // something else refuses the run instead of failing it.
        if (!Arr.isReadonlyArrayNonEmpty(waitingFor)) yield* games.hold(id);
        const first: ImageRunStatus = {
          phase: Arr.isReadonlyArrayNonEmpty(waitingFor)
            ? { _tag: "Waiting", for: waitingFor }
            : { _tag: "Running" },
          total: 0,
          done: 0,
          entries: 0,
          failed: [],
          warnings: [],
        };
        const current = yield* SubscriptionRef.make(first);
        yield* SubscriptionRef.update(statuses, (runs) => new Map(runs).set(id, current));
        const going = Arr.isReadonlyArrayNonEmpty(waitingFor)
          ? turn
              .ready((now) =>
                SubscriptionRef.update(current, (last) => ({
                  ...last,
                  phase: { _tag: "Waiting" as const, for: now },
                })),
              )
              .pipe(
                Effect.andThen(games.hold(id)),
                Effect.andThen(
                  SubscriptionRef.update(current, (last) => ({
                    ...last,
                    phase: { _tag: "Running" as const },
                  })),
                ),
              )
          : Effect.void;
        yield* FiberMap.run(
          fibers,
          id,
          going.pipe(
            Effect.andThen(read(game, settings, current, again)),
            Scope.provide(scope),
            Effect.onExit((exit) =>
              SubscriptionRef.update(current, (now) =>
                now.phase._tag === "Waiting" ? now : { ...now, phase: { _tag: "Ending" as const } },
              ).pipe(Effect.andThen(Scope.close(scope, exit)), Effect.andThen(end(current, exit))),
            ),
          ),
        );
        return first;
      }).pipe(
        Scope.provide(scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      ),
    );
  }, starts.withPermits(1));

  const stop = Effect.fn("ImageReading.stop")(function* (id: string) {
    yield* games.get(id);
    yield* FiberMap.remove(fibers, id);
    return yield* status(id);
  });

  const clear = Effect.fn("ImageReading.clear")(function* (id: string) {
    if (yield* FiberMap.has(fibers, id)) return yield* new Games.GameBusyError({ id });
    return yield* games.exclusive(
      id,
      Effect.gen(function* () {
        const current = yield* catalogs.get(id);
        const next = {
          ...current,
          entries: current.entries.filter((entry) => !isImageText(entry)),
        };
        yield* Effect.uninterruptible(Effect.andThen(catalogs.save(next), imageTexts.clear(id)));
        yield* SubscriptionRef.update(statuses, (runs) => {
          const rest = new Map(runs);
          rest.delete(id);
          return rest;
        });
        return next;
      }),
    );
  });

  return ImageReading.of({ results, exported, status, changes, start, stop, clear });
});

export const layer = Layer.effect(ImageReading, make);
