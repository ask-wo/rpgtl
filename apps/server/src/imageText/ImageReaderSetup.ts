import {
  ImageReaderDevice,
  ImageReaderModelPart,
  type ImageReaderSetupStatus,
  type ImageReaderSetupStep,
} from "@rpgtl/contracts";
import { localEndpoint } from "@rpgtl/domain";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { countingProxy } from "../downloads/countingProxy.ts";
import { makeFetchPinnedArchive, type PinnedArchive } from "../downloads/pinnedArchive.ts";
import { NvidiaSmi } from "../localModels/FreeMemory.ts";
import { OnWindows } from "../OnWindows.ts";
import { userFolder } from "../state/userFolders.ts";
import {
  dryRunPlan,
  lockedFiles,
  lockedPythonMinor,
  plannedFiles,
  type Platform,
} from "./lockedDownloads.ts";

class ImageReaderSetupError extends Schema.TaggedError<ImageReaderSetupError>()(
  "ImageReaderSetupError",
  {
    step: Schema.Literals(["packages", "models", "save"]),
    /** The log with the failing program's output. */
    log: Schema.String,
    /** The failing program's last line of output, which usually says why. */
    lastLine: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    const what = {
      packages: "Installing the image reader's packages failed",
      models: "Converting the image reader's models failed",
      save: "Couldn't save the image reader in RPGTL's cache folder",
    }[this.step];
    return this.lastLine === undefined
      ? `${what}. Its log says why: ${this.log}`
      : `${what}: ${this.lastLine} (log: ${this.log})`;
  }
}

export class ImageReaderMissingError extends Schema.TaggedError<ImageReaderMissingError>()(
  "ImageReaderMissingError",
  {
    /** What isn't set up: the reader, or its Korean recognizer, which a Korean game needs. */
    missing: Schema.Literals(["reader", "korean"]),
  },
) {
  override get message() {
    return this.missing === "reader"
      ? "The image reader isn't set up. Set it up in Settings."
      : "Reading a Korean game's images needs the Korean text model. Add it in Settings.";
  }
}

export class ImageReaderRemoveError extends Schema.TaggedError<ImageReaderRemoveError>()(
  "ImageReaderRemoveError",
  {
    problem: Schema.Literals(["busy", "save"]),
    /** The reader's folder. */
    folder: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return this.problem === "busy"
      ? "The image reader is being set up. Wait until it has finished."
      : "Couldn't delete the image reader's folder. RPGTL's log says why.";
  }
}

interface UvRelease extends PinnedArchive {
  /** The uv program in the unpacked folder. */
  readonly program: string;
}

const linuxUv: UvRelease = {
  what: "uv",
  url: "https://github.com/astral-sh/uv/releases/download/0.13.7/uv-x86_64-unknown-linux-gnu.tar.gz",
  size: 16_671_812,
  sha256: "c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83",
  folder: "uv-x86_64-unknown-linux-gnu",
  program: "uv",
};

const windowsUv: UvRelease = {
  what: "uv",
  url: "https://github.com/astral-sh/uv/releases/download/0.13.7/uv-x86_64-pc-windows-msvc.zip",
  size: 15_236_317,
  sha256: "0cdc5b38fe5a8168ed6a25814f5ba43c21d313dd3187314fccb37b7cec46e021",
  folder: "",
  program: "uv.exe",
};

/** The uv build that installs the reader; tests serve a fake one. */
export const UvRelease = Context.Reference<UvRelease>("@rpgtl/server/imageText/UvRelease", {
  defaultValue: () => (process.platform === "win32" ? windowsUv : linuxUv),
});

/**
 * The reader's Python project: `apps/image-reader` in the repo. The portable download carries a
 * copy next to its server.
 */
export const ReaderSources = Context.Reference<string>("@rpgtl/server/imageText/ReaderSources", {
  defaultValue: () => fileURLToPath(new URL("../../../image-reader", import.meta.url)),
});

const mebibyte = 2 ** 20;

/**
 * About how many bytes setting up downloads, shown before it starts: the packages for the reader
 * and the two conversions on Linux, of which NVIDIA's CUDA libraries are most of the GPU's, and
 * the models the conversions download. While it downloads, the lockfiles give the exact size.
 */
const aboutDownload: Record<ImageReaderDevice, number> = {
  gpu: 2_450 * mebibyte,
  directml: 980 * mebibyte,
  cpu: 980 * mebibyte,
};

/** About how many bytes the Korean recognizer's model is, which PaddleX downloads. */
const koreanModel = 14 * mebibyte;

/**
 * About how many bytes adding the Korean recognizer to a reader set up without it downloads: the
 * OCR conversion's packages again, of which Paddle is most, and the model.
 */
const koreanLater = (windows: boolean) => (windows ? 222 * mebibyte : 341 * mebibyte) + koreanModel;

const lamaParts: ReadonlyArray<ImageReaderModelPart> = ["lamaDownload", "lamaCheck", "lamaExport"];

const phaseOf = (now: Progress): ImageReaderSetupStatus["phase"] => {
  switch (now._tag) {
    case "Idle":
      return Option.match(now.error, {
        onNone: () => ({ _tag: "Idle" }),
        onSome: (error) => ({ _tag: "Idle", error }),
      });
    case "Removing":
      return now;
    case "SettingUp":
      return {
        _tag: "SettingUp",
        step: now.step,
        parts: now.parts,
        ...(Option.isSome(now.part) && { part: now.part.value }),
        ...(Option.isSome(now.total) && {
          downloading: {
            done: Math.min(now.downloaded, now.total.value),
            total: now.total.value,
          },
        }),
      };
  }
};

/** What a setup that starts now reports first. */
const beginning = (
  step: ImageReaderSetupStep,
  parts: ReadonlyArray<ImageReaderModelPart>,
): SettingUp => ({
  _tag: "SettingUp",
  step,
  parts,
  part: Option.none(),
  downloaded: 0,
  total: Option.none(),
});

/** Proxies the user set, which uv goes through instead of RPGTL's counting one. */
const proxyVariables = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];

const GlibcReport = Schema.Struct({
  header: Schema.Struct({ glibcVersionRuntime: Schema.String }),
});

/** The NVIDIA driver the CUDA 13 build of ONNX Runtime needs. */
const minimumDriver = 580;

/** The computer uv installs for, with the Python its dry run says it uses. */
const platform = (windows: boolean, pythonMinor: number): Platform => ({
  os: windows ? "windows" : "linux",
  pythonMinor,
  glibc: Schema.decodeUnknownOption(GlibcReport)(process.report.getReport()).pipe(
    Option.map(({ header }): Platform["glibc"] => {
      const [major = 0, minor = 0] = header.glibcVersionRuntime.split(".").map(Number);
      return [major, minor];
    }),
    Option.getOrElse((): Platform["glibc"] => [0, 0]),
  ),
});

/** What starting the reader needs. */
export interface Installation {
  readonly python: string;
  readonly sources: string;
  readonly models: string;
  readonly device: ImageReaderDevice;
  /** Where the reader's own output goes. */
  readonly log: string;
}

/**
 * The image reader's Python, packages and converted models in `image-reader/` of RPGTL's cache
 * folder, set up once when the user asks.
 */
export class ImageReaderSetup extends Context.Service<
  ImageReaderSetup,
  {
    /** The status now and after each change, until the stream is closed. */
    readonly changes: Stream.Stream<ImageReaderSetupStatus>;
    /**
     * Starts setting up the reader unless it is set up or on its way, and gives the status. It
     * goes on in the background until it ends or RPGTL exits. With `korean`, it sets up the
     * Korean recognizer too, adding it to a reader set up without it.
     */
    readonly setUp: (options: {
      readonly korean: boolean;
    }) => Effect.Effect<ImageReaderSetupStatus>;
    /** Deletes the reader's folder. */
    readonly remove: Effect.Effect<ImageReaderSetupStatus, ImageReaderRemoveError>;
    /** Deletes the Korean recognizer. */
    readonly removeKorean: Effect.Effect<ImageReaderSetupStatus, ImageReaderRemoveError>;
    /** What starting the reader needs, once it is set up. */
    readonly installation: Effect.Effect<Installation, ImageReaderMissingError>;
    /**
     * A reader started outside RPGTL, such as one from the repo's sources or a fake in a test,
     * which RPGTL uses instead of its own: `RPGTL_IMAGE_READER`.
     */
    readonly external: Option.Option<URL>;
  }
>()("@rpgtl/server/imageText/ImageReaderSetup") {}

interface SettingUp {
  readonly _tag: "SettingUp";
  readonly step: ImageReaderSetupStep;
  /** The parts of converting the models this setup runs. */
  readonly parts: ReadonlyArray<ImageReaderModelPart>;
  /** The part of converting the models it is on. */
  readonly part: Option.Option<ImageReaderModelPart>;
  /** Bytes received so far of the packages, or of the model the part downloads. */
  readonly downloaded: number;
  /** Bytes of that download, when known. */
  readonly total: Option.Option<number>;
}

type Progress =
  | { readonly _tag: "Idle"; readonly error: Option.Option<string> }
  | SettingUp
  | { readonly _tag: "Removing" };

const idle = (error: Option.Option<string>): Progress => ({ _tag: "Idle", error });

interface Attempt {
  readonly attempt: number;
  readonly now: Progress;
}

/** A line a conversion prints as one of its parts starts: `@rpgtl part <name>`. */
const partLine = /^@rpgtl part (\w+)$/;
/** A line a conversion prints as its download goes: `@rpgtl bytes <done> <total>`. */
const bytesLine = /^@rpgtl bytes (\d+) (\d+)$/;

/**
 * `setup.json`, written once setting up is done. `installs` is a hash of what setting up installs
 * from, so a new RPGTL that installs other packages or models counts as not set up.
 */
const Marker = Schema.fromJsonString(
  Schema.Struct({ device: ImageReaderDevice, installs: Schema.String }),
);

/** The reader's files that decide what setting it up installs, in its Python project. */
export const setupFiles = [
  "pyproject.toml",
  "uv.lock",
  "convert/ocr/pyproject.toml",
  "convert/ocr/uv.lock",
  "convert/ocr/convert_ocr.py",
  "convert/lama/pyproject.toml",
  "convert/lama/uv.lock",
  "convert/lama/lama.py",
  "convert/lama/convert_lama.py",
];

/** A `uv sync` of one of the Python projects into its environment. */
interface Sync {
  readonly project: string;
  readonly environment: string;
  readonly options: ReadonlyArray<string>;
}

interface Detected {
  readonly device: ImageReaderDevice;
  readonly note?: string;
}

// Game images go only to a reader on this computer.
const ReaderAddress = Schema.String.check(
  Schema.makeFilter(
    (text) =>
      Result.isSuccess(localEndpoint(text)) ||
      "must be an address on this computer, such as http://127.0.0.1:5001",
  ),
);

const make = Effect.gen(function* () {
  const external = Option.map(
    yield* Config.option(Config.schema(ReaderAddress, "RPGTL_IMAGE_READER")),
    (address) => new URL(address),
  );
  const userProxy = Option.firstSomeOf(
    yield* Config.all(proxyVariables.map((name) => Config.option(Config.String(name)))),
  );
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects());
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fetchPinnedArchive = yield* makeFetchPinnedArchive;
  const uvRelease = yield* UvRelease;
  const sources = yield* ReaderSources;
  const nvidiaSmi = yield* NvidiaSmi;
  const windows = yield* OnWindows;
  const folder = path.join(yield* userFolder("cache"), "image-reader");
  const at = (...parts: ReadonlyArray<string>) => path.join(folder, ...parts);
  const uv = at("uv", uvRelease.program);
  const models = at("models");
  // The reader looks for the Korean recognizer here (`apps/image-reader/models.py`).
  const koreanModels = path.join(models, "korean");
  const marker = at("setup.json");
  const setupLog = at("setup.log");
  const pythonIn = (environment: string) =>
    windows ? at(environment, "Scripts", "python.exe") : at(environment, "bin", "python");
  const python = pythonIn("venv");
  // Setting up runs in the layer's scope, so RPGTL exiting stops it.
  const scope = yield* Effect.scope;
  const progress = yield* SubscriptionRef.make<Attempt>({ attempt: 0, now: idle(Option.none()) });

  /** The device this computer can run the reader on, and why not a better one. */
  const detected = yield* spawner
    .string(ChildProcess.make(nvidiaSmi, ["--query-gpu=driver_version", "--format=csv,noheader"]))
    .pipe(
      Effect.map((output): Detected => {
        const major = Number(/^(\d+)\./.exec(output.trim())?.[1]);
        if (major >= minimumDriver) return { device: "gpu" };
        const fallback = windows ? "directml" : "cpu";
        return Number.isNaN(major)
          ? { device: fallback }
          : {
              device: fallback,
              note: `The NVIDIA driver ${major} is older than ${minimumDriver}, which the reader needs for the GPU. Update it and restart RPGTL, then set the reader up again.`,
            };
      }),
      Effect.catchTags({
        PlatformError: () => Effect.succeed<Detected>({ device: windows ? "directml" : "cpu" }),
      }),
    );

  const installs = createHash("sha256").update(uvRelease.sha256);
  for (const file of setupFiles) {
    const text = yield* fs.readFile(path.join(sources, file)).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(error),
      }),
      Effect.orDie,
    );
    installs.update(`${file}\n`);
    if (Option.isSome(text)) installs.update(text.value);
  }
  const installsNow = installs.digest("hex");

  const installedDevice = fs.readFileString(marker).pipe(
    Effect.flatMap(Schema.decodeEffect(Marker)),
    Effect.map((saved) =>
      saved.installs === installsNow ? Option.some(saved.device) : Option.none(),
    ),
    Effect.catchTags({
      PlatformError: () => Effect.succeed(Option.none<ImageReaderDevice>()),
      SchemaError: () => Effect.succeed(Option.none<ImageReaderDevice>()),
    }),
  );

  const exists = (file: string) =>
    fs.exists(file).pipe(Effect.catchTags({ PlatformError: () => Effect.succeed(false) }));
  // Its folder is renamed into place once converted, so a folder there is a whole model.
  const koreanReady = exists(koreanModels);

  const statusOf = ({ attempt, now }: Attempt) =>
    Effect.map(
      Effect.all([installedDevice, exists(folder), koreanReady]),
      ([installed, onDisk, korean]): ImageReaderSetupStatus => {
        const device = Option.getOrElse(installed, () => detected.device);
        return {
          device,
          ...(detected.note !== undefined && { note: detected.note }),
          download: aboutDownload[device],
          folder,
          ready: Option.isSome(installed),
          onDisk,
          korean: {
            ready: Option.isSome(installed) && korean,
            download: Option.isSome(installed) ? koreanLater(windows) : koreanModel,
          },
          phase: phaseOf(now),
          ...(Option.isSome(external) && { external: external.value.origin }),
          attempt,
        };
      },
    );

  const status = Effect.flatMap(SubscriptionRef.get(progress), statusOf);
  const changes = SubscriptionRef.changes(progress).pipe(Stream.mapEffect(statusOf));
  const whileSettingUp = (change: (now: SettingUp) => SettingUp) =>
    SubscriptionRef.update(progress, (last) =>
      last.now._tag === "SettingUp" ? { ...last, now: change(last.now) } : last,
    );
  const settle = (now: Progress) => SubscriptionRef.update(progress, (last) => ({ ...last, now }));
  const enter = (step: ImageReaderSetupStep) => whileSettingUp((now) => beginning(step, now.parts));

  /** Follows the parts and the download a conversion reports. */
  const followConversion = (line: string) => {
    const started = partLine.exec(line)?.[1];
    if (started !== undefined)
      return Option.match(Schema.decodeUnknownOption(ImageReaderModelPart)(started), {
        onNone: () => Effect.void,
        onSome: (part) =>
          whileSettingUp((last) => ({
            ...last,
            part: Option.some(part),
            downloaded: 0,
            total: Option.none(),
          })),
      });
    const [, done, total] = bytesLine.exec(line) ?? [];
    if (done === undefined || total === undefined) return Effect.void;
    return whileSettingUp((last) => ({
      ...last,
      downloaded: Number(done),
      total: Option.some(Number(total)),
    }));
  };

  const uvEnv = (environment: string) => ({
    UV_PYTHON_INSTALL_DIR: at("python"),
    UV_CACHE_DIR: at("cache"),
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_NO_CONFIG: "1",
    UV_PROJECT_ENVIRONMENT: at(environment),
    PADDLE_PDX_CACHE_HOME: at("paddlex"),
    // On Windows Python writes to a pipe in the system's code page, which has no ✅ for torch.
    PYTHONUTF8: "1",
  });

  /**
   * Runs a program with its output appended to the setup log, each line to `heard` too, failing
   * with `step` and the program's last line unless it succeeds.
   */
  const run = Effect.fn("ImageReaderSetup.run")(function* (
    step: "packages" | "models",
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly environment: string;
      readonly heard?: (line: string) => Effect.Effect<void>;
      /** The proxy uv downloads through. */
      readonly proxy?: string;
    },
  ) {
    let lastLine = "";
    const failure = (cause?: unknown) =>
      new ImageReaderSetupError({
        step,
        log: setupLog,
        ...(lastLine !== "" && { lastLine }),
        ...(cause !== undefined && { cause }),
      });
    yield* fs
      .writeFileString(setupLog, `\n$ ${[command, ...args].join(" ")}\n`, { flag: "a" })
      .pipe(Effect.mapError(failure));
    const code = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            cwd: sources,
            env: {
              ...uvEnv(options.environment),
              ...(options.proxy !== undefined && {
                HTTPS_PROXY: options.proxy,
                NO_PROXY: "",
                ...(!windows && { https_proxy: options.proxy, no_proxy: "" }),
              }),
            },
            extendEnv: true,
            stdin: "ignore",
          }),
        );
        yield* handle.all.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.tap((line) => {
            // Progress bars rewrite their line with carriage returns; the last state is the line.
            const shown = line.split("\r").at(-1)?.trim() ?? "";
            if (shown !== "" && !shown.startsWith("@rpgtl ")) lastLine = shown;
            return options.heard?.(shown) ?? Effect.void;
          }),
          Stream.map((line) => `${line}\n`),
          Stream.encodeText,
          Stream.run(fs.sink(setupLog, { flag: "a" })),
        );
        return yield* handle.exitCode;
      }),
    ).pipe(Effect.mapError(failure));
    if (code !== 0) return yield* failure(`exit code ${code}`);
  });

  /** The size of a file its index didn't give one for, as its server says. */
  const sizeOf = (url: string) =>
    client.head(url).pipe(
      Effect.map((response) => Option.fromUndefinedOr(response.headers["content-length"])),
      Effect.map(Option.map(Number)),
      Effect.catchTags({ HttpClientError: () => Effect.succeed(Option.none<number>()) }),
    );

  /**
   * How many bytes the syncs download together, from what uv says it would install and the
   * files the lockfiles name for them, unless a file's size is unknown. A file several of them
   * need comes once, as uv keeps it in its cache.
   */
  const planned = Effect.fn("ImageReaderSetup.planned")(function* (syncs: ReadonlyArray<Sync>) {
    const files = new Map<string, number | undefined>();
    for (const { project, environment, options } of syncs) {
      const output: Array<string> = [];
      yield* run(
        "packages",
        uv,
        ["sync", "--dry-run", "--frozen", ...options, "--project", project],
        {
          environment,
          heard: (line) => Effect.sync(() => output.push(line)),
        },
      );
      const lock = yield* fs
        .readFileString(path.join(project, "uv.lock"))
        .pipe(Effect.catchTags({ PlatformError: () => Effect.succeed("") }));
      const pythonMinor = lockedPythonMinor(lock);
      if (pythonMinor === undefined) return Option.none<number>();
      for (const file of plannedFiles(
        lockedFiles(lock),
        dryRunPlan(output),
        platform(windows, pythonMinor),
      ))
        files.set(file.url, file.size);
    }
    const sizes = yield* Effect.forEach(
      files,
      ([url, size]) => (size === undefined ? sizeOf(url) : Effect.succeedSome(size)),
      { concurrency: 8 },
    );
    return Option.map(Option.all(sizes), (known) => known.reduce((sum, size) => sum + size, 0));
  });

  const remove = (file: string) => fs.remove(file, { recursive: true, force: true });

  const save = (cause: unknown) =>
    new ImageReaderSetupError({ step: "save", log: setupLog, cause });

  /** The environment a conversion runs in, from the folder of `apps/image-reader/convert`. */
  const conversion = (model: "ocr" | "lama"): Sync => ({
    project: path.join(sources, "convert", model),
    environment: `convert-${model}`,
    options: [],
  });

  /** Installs the syncs' packages, with the bytes uv receives as the download's progress. */
  const installPackages = Effect.fn("ImageReaderSetup.installPackages")(function* (
    syncs: ReadonlyArray<Sync>,
  ) {
    const total = yield* planned(syncs);
    yield* whileSettingUp((last) => ({ ...last, step: "packages", total }));
    yield* Effect.scoped(
      Effect.gen(function* () {
        let received = 0;
        const proxy = Option.isSome(userProxy)
          ? undefined
          : yield* countingProxy((bytes) => {
              received += bytes;
            });
        let published = 0;
        yield* Effect.suspend(() => {
          if (received === published) return Effect.void;
          published = received;
          return whileSettingUp((last) => ({ ...last, downloaded: published }));
        }).pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped);
        for (const { project, environment, options } of syncs)
          yield* run("packages", uv, ["sync", "--frozen", ...options, "--project", project], {
            environment,
            ...(proxy !== undefined && { proxy }),
          });
      }),
    );
  });

  /** Runs a conversion script, which writes its models into `output`. */
  const convert = (model: "ocr" | "lama", output: string, args: ReadonlyArray<string> = []) => {
    const { project, environment } = conversion(model);
    return run(
      "models",
      pythonIn(environment),
      [path.join(project, `convert_${model}.py`), output, ...args],
      { environment, heard: followConversion },
    );
  };

  /** Deletes the conversions' environments and downloads, which only converting needs. */
  const cleanUp = Effect.gen(function* () {
    yield* enter("cleanup");
    for (const leftover of ["convert-ocr", "convert-lama", "paddlex", "cache"])
      yield* remove(at(leftover)).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            Effect.logWarning("Couldn't remove what setting up the image reader left.", error),
        }),
      );
  });

  const install = Effect.fn("ImageReaderSetup.install")(function* (korean: boolean) {
    const device = detected.device;
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(save));
    yield* remove(marker).pipe(Effect.mapError(save));
    yield* fs.writeFileString(setupLog, "").pipe(Effect.mapError(save));

    yield* enter("uv");
    yield* fetchPinnedArchive(uvRelease, at("uv"), () => Effect.void);

    yield* installPackages([
      { project: sources, environment: "venv", options: ["--no-dev", "--extra", device] },
      conversion("ocr"),
      conversion("lama"),
    ]);

    yield* enter("models");
    const converted = at("models.part");
    yield* remove(converted).pipe(Effect.mapError(save));
    yield* convert("ocr", converted, korean ? ["general", "korean"] : ["general"]);
    yield* convert("lama", converted);
    yield* Effect.uninterruptible(
      Effect.andThen(remove(models), fs.rename(converted, models)),
    ).pipe(Effect.mapError(save));

    yield* cleanUp;
    const saved = yield* Schema.encodeEffect(Marker)({ device, installs: installsNow }).pipe(
      Effect.mapError(save),
    );
    yield* fs.writeFileString(marker, saved).pipe(Effect.mapError(save));
  });

  /** Adds the Korean recognizer to the reader, set up without it. */
  const addKorean = Effect.gen(function* () {
    yield* fs.writeFileString(setupLog, "").pipe(Effect.mapError(save));
    yield* installPackages([conversion("ocr")]);
    yield* enter("models");
    const converted = at("korean.part");
    yield* remove(converted).pipe(Effect.mapError(save));
    yield* convert("ocr", converted, ["korean"]);
    yield* Effect.uninterruptible(
      Effect.andThen(remove(koreanModels), fs.rename(path.join(converted, "korean"), koreanModels)),
    ).pipe(Effect.andThen(remove(converted)), Effect.mapError(save));
    yield* cleanUp;
  }).pipe(Effect.withSpan("ImageReaderSetup.addKorean"));

  /** Runs a setup, keeping why it failed for the status. */
  const settingUp = <E extends Error, R>(job: Effect.Effect<void, E, R>) =>
    job.pipe(
      Effect.matchCauseEffect({
        onSuccess: () => settle(idle(Option.none())),
        onFailure: (cause) =>
          Effect.gen(function* () {
            const error = Option.getOrUndefined(Cause.findErrorOption(cause));
            if (error) yield* Effect.logWarning(error.message, error.cause);
            else yield* Effect.logError("Setting up the image reader stopped.", cause);
            yield* settle(
              idle(
                Option.some(error?.message ?? "Setting up the image reader stopped. Try again."),
              ),
            );
          }),
      }),
    );

  const setUp = Effect.fn("ImageReaderSetup.setUp")(function* ({
    korean,
  }: {
    readonly korean: boolean;
  }) {
    yield* SubscriptionRef.updateEffect(progress, (last) =>
      Effect.gen(function* () {
        if (last.now._tag !== "Idle") return last;
        const installed = Option.isSome(yield* installedDevice);
        if (installed && (!korean || (yield* koreanReady))) return last;
        if (installed) {
          yield* Effect.forkIn(settingUp(addKorean), scope);
          return {
            attempt: last.attempt + 1,
            now: beginning("packages", ["koreanRecognition"]),
          };
        }
        yield* Effect.forkIn(settingUp(install(korean)), scope);
        return {
          attempt: last.attempt + 1,
          now: beginning("uv", [
            "textDetection",
            "textRecognition",
            ...(korean ? (["koreanRecognition"] as const) : []),
            ...lamaParts,
          ]),
        };
      }),
    );
    return yield* status;
  });

  /** Deletes `file` unless setting up or another removal runs. */
  const removing = Effect.fn("ImageReaderSetup.remove")(function* (file: string) {
    yield* SubscriptionRef.updateEffect(progress, (last) =>
      last.now._tag !== "Idle"
        ? Effect.fail(new ImageReaderRemoveError({ problem: "busy", folder: file }))
        : Effect.succeed<Attempt>({ ...last, now: { _tag: "Removing" } }),
    );
    yield* remove(file).pipe(
      Effect.mapError(
        (cause) => new ImageReaderRemoveError({ problem: "save", folder: file, cause }),
      ),
      Effect.ensuring(settle(idle(Option.none()))),
    );
    return yield* status;
  }, Effect.uninterruptible);

  const installation = installedDevice.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new ImageReaderMissingError({ missing: "reader" })),
        onSome: (device) =>
          Effect.succeed<Installation>({ python, sources, models, device, log: at("reader.log") }),
      }),
    ),
    Effect.withSpan("ImageReaderSetup.installation"),
  );

  return ImageReaderSetup.of({
    changes,
    setUp,
    remove: removing(folder),
    removeKorean: removing(koreanModels),
    installation,
    external,
  });
});

export const layer = Layer.effect(ImageReaderSetup, make);
