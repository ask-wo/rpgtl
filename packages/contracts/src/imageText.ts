import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { LetteringFont } from "./catalog.ts";
import { ExpertLayers, runPhase } from "./translation.ts";

/**
 * A record whose keys must match `key`. A refined key schema would drop the other keys silently
 * instead of failing on them.
 */
export const RecordWith = <S extends Schema.Top>(key: RegExp, expected: string, value: S) =>
  Schema.Record(Schema.String, value).check(
    Schema.makeFilter((record) =>
      Object.keys(record).flatMap((name) =>
        key.test(name) ? [] : [{ path: [name], issue: `Expected ${expected}` }],
      ),
    ),
  );

const Point = Schema.Tuple([Schema.Finite, Schema.Finite]);
/** Left, top, right and bottom, in pixels. */
export const Box = Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite, Schema.Finite]);
export type Box = typeof Box.Type;

/** A line of text the image reader found, in the image's pixels. */
export const ImageLine = Schema.Struct({
  text: Schema.String,
  score: Schema.optionalKey(Schema.Finite),
  /** Largest RGB or opacity range inside the original polygon, from 0 to 255. */
  contrast: Schema.optionalKey(Schema.Finite),
  polygon: Schema.Array(Point),
  box: Box,
  reader: Schema.Literals(["paddle", "qwen"]),
  rough: Schema.optionalKey(Schema.Literal(true)),
  /** Found only when the image was read again at twice its size. */
  enlarged: Schema.optionalKey(Schema.Literal(true)),
});
export type ImageLine = typeof ImageLine.Type;

/** How the English is drawn for one block of lines, as the reader service's /prepare describes it. */
export const PreparedBlock = Schema.Struct({
  /** Indices into the result's lines, the same as in the entry's path after "lines". */
  lines: Schema.Array(Schema.Int),
  /** How far the erased areas were grown beyond their polygons. */
  grow: Schema.Finite,
  polygons: Schema.Array(Schema.Array(Point)),
  /**
   * The degrees clockwise from rightwards at which tilted text runs, or 90 down a column; absent
   * for level text. `area` and `space` are then in the text's own frame: turned by `angle` around
   * the middle of `area`, they lie on the image. `polygons` are always in the image's pixels.
   */
  angle: Schema.optionalKey(Schema.Finite),
  area: Box,
  /** The height of the block's tallest line, across the text's direction when it is turned. */
  lineHeight: Schema.Finite,
  space: Box,
  /** Null when the block has no text colour, so there is nothing to draw it with. */
  fill: Schema.NullOr(Schema.String),
  outline: Schema.NullOr(Schema.String),
  stroke: Schema.Finite,
  weight: Schema.Finite,
  bold: Schema.Boolean,
  align: Schema.Literals(["left", "centre"]),
  group: Schema.Finite,
});
export type PreparedBlock = typeof PreparedBlock.Type;

/** One translated block of an image, with what the game needs to erase the original and draw it. */
export const DrawBlock = PreparedBlock.mapFields((fields) => ({
  ...Struct.omit(fields, ["lines", "weight"]),
  text: Schema.String,
  fill: Schema.String,
}));
export type DrawBlock = typeof DrawBlock.Type;

/** The erased copy of an image and the blocks to draw into it, as System.json's `rpgtlImageText`. */
export const ImageTextHint = Schema.Struct({
  /** The erased image's address. */
  erased: Schema.String,
  blocks: Schema.Array(DrawBlock),
  /** Absent draws the English in the game's own font. */
  font: Schema.optionalKey(LetteringFont),
  /**
   * The blocks of the other images of its series, such as a menu's `Command_0` to `Command_3`,
   * whose English takes one size.
   */
  series: Schema.optionalKey(Schema.Array(Schema.Array(DrawBlock))),
});
export type ImageTextHint = typeof ImageTextHint.Type;

/** What an image reading run read and erased with. */
export const ImageRun = Schema.Struct({
  /** The models of the image reader, as it names them. */
  detection: Schema.String,
  recognition: Schema.String,
  inpainting: Schema.String,
  /** The Ollama model that read what the image reader read only partly, if the run had one. */
  backupReader: Schema.optionalKey(Schema.String),
  includeFaint: Schema.Boolean,
});
export type ImageRun = typeof ImageRun.Type;

/** What the reader found in one image. */
const imageResultFields = {
  file: Schema.String,
  sha256: Schema.String,
  width: Schema.Finite,
  height: Schema.Finite,
  lines: Schema.Array(ImageLine),
  fallback: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  /** The file in the game's erased images folder, named by its content. Not set without blocks. */
  erased: Schema.optionalKey(Schema.String),
  /** Set once the image has been prepared for drawing, empty when it has no entries. */
  blocks: Schema.optionalKey(Schema.Array(PreparedBlock)),
  /** Which way of measuring contrast the lines' contrasts come from. */
  contrastVersion: Schema.optionalKey(Schema.Int),
  includeFaint: Schema.optionalKey(Schema.Boolean),
  /**
   * 3 once larger images are also read at twice their size, for small lettering on busy artwork; 4
   * once a Qwen line takes its place from Paddle's pieces of it beside it.
   */
  readVersion: Schema.optionalKey(Schema.Int),
  /** 2 once thin outlined lettering gets its own fill and outline colours. */
  preparedVersion: Schema.optionalKey(Schema.Int),
  /** When the image reading run that last read or erased this image started, as an ISO time. */
  run: Schema.optionalKey(Schema.String),
};

/** Every block of a result names only lines it has. */
const blocksOfItsLines = Schema.makeFilter(
  (result: {
    readonly lines: ReadonlyArray<unknown>;
    readonly blocks?: ReadonlyArray<{ readonly lines: ReadonlyArray<number> }>;
  }) => (result.blocks ?? []).every((block) => block.lines.every((index) => index in result.lines)),
);

export const ImageResult = Schema.Struct(imageResultFields).check(blocksOfItsLines);
export type ImageResult = typeof ImageResult.Type;

/** `games/<game id>/images.json` in the state folder: what the reader found, by image path. */
export const ImageReadResults = Schema.Struct({
  version: Schema.Literal(1),
  images: RecordWith(/^img\//, "an image path", ImageResult),
  /** What each run an image's `run` names used, by that start time. */
  runs: Schema.optionalKey(Schema.Record(Schema.String, ImageRun)),
});
export type ImageReadResults = typeof ImageReadResults.Type;

/** A rectangle of an erased background that differs from the game's image, as a PNG. */
export const ErasedPatch = Schema.Struct({
  x: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  y: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  png: Schema.Uint8ArrayFromBase64,
});
export type ErasedPatch = typeof ErasedPatch.Type;

/**
 * An image's read result as a translation file carries it: its erased background as the patches to
 * draw over the game's image, which import puts together again, and without its file, which import
 * takes from the game.
 */
export const ExportedImage = Schema.Struct({
  ...Struct.omit(imageResultFields, ["file", "erased"]),
  erased: Schema.optionalKey(Schema.Array(ErasedPatch)),
}).check(blocksOfItsLines);
export type ExportedImage = typeof ExportedImage.Type;

/** The read results of the images the game still has as they were read, and their runs. */
export const ExportedImageText = Schema.Struct({
  images: RecordWith(/^img\//, "an image path", ExportedImage),
  runs: ImageReadResults.fields.runs,
});
export type ExportedImageText = typeof ExportedImageText.Type;

/** How a game's images are read. */
export const ImageReadingSettings = Schema.Struct({
  /** Ollama, which holds the backup reader. */
  ollamaEndpoint: Schema.String,
  /**
   * The Ollama model that reads what the image reader read only partly, and checks single
   * characters; without one, those images keep the image reader's lines.
   */
  fallbackModel: Schema.optionalKey(
    Schema.String.annotate({ message: "The backup reader must be an Ollama model name." }),
  ),
  /** Keeps faint lettering too, which is skipped as watermarks otherwise. */
  includeFaint: Schema.Boolean.annotate({ message: "includeFaint must be true or false." }),
  /**
   * Runs the backup reader in llama-server with the experts of at least this many layers in system
   * RAM, and more until the rest fits; Ollama runs it without.
   */
  expertLayersInRam: Schema.optionalKey(ExpertLayers),
});
export type ImageReadingSettings = typeof ImageReadingSettings.Type;

/** The images a run reads from scratch even when their saved result is current: all, or these. */
export const ReadAgain = Schema.Union([
  Schema.Literal("all"),
  Schema.Array(Schema.String.check(Schema.isPattern(/^img\//))),
]).annotate({ message: 'again must be "all" or a list of image paths.' });
export type ReadAgain = typeof ReadAgain.Type;

/** How far a game's image reading got. */
export const ImageRunStatus = Schema.Struct({
  phase: runPhase({
    /** Set while the fallback reader reads the partly read images, after all others are read. */
    fallback: Schema.optionalKey(
      Schema.Struct({
        done: Schema.Int,
        total: Schema.Int,
        /** Why the fallback reader waits for free memory, while it does. */
        waiting: Schema.optionalKey(Schema.String),
      }),
    ),
    /** The reader whose models load meanwhile, which takes a while before it reads anything. */
    loading: Schema.optionalKey(Schema.Literals(["imageReader", "backupReader"])),
  }),
  /** Images the run set out to read. */
  total: Schema.Int,
  done: Schema.Int,
  /** Image text entries in the catalog. */
  entries: Schema.Int,
  /** Images that couldn't be read, by image path. */
  failed: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
});
export type ImageRunStatus = typeof ImageRunStatus.Type;

/** How the image reader runs: on an NVIDIA GPU, through DirectML on Windows, or on the processor. */
export const ImageReaderDevice = Schema.Literals(["gpu", "directml", "cpu"]);
export type ImageReaderDevice = typeof ImageReaderDevice.Type;

/**
 * The parts of converting the reader's models, in the order they run: the OCR's two models, the
 * Korean recognizer when it is asked for, then LaMa's download, the check that the rebuilt LaMa
 * matches the original, and its export.
 */
export const ImageReaderModelPart = Schema.Literals([
  "textDetection",
  "textRecognition",
  "koreanRecognition",
  "lamaDownload",
  "lamaCheck",
  "lamaExport",
]);
export type ImageReaderModelPart = typeof ImageReaderModelPart.Type;

export const ImageReaderSetupStep = Schema.Literals(["uv", "packages", "models", "cleanup"]);
export type ImageReaderSetupStep = typeof ImageReaderSetupStep.Type;

/** Whether RPGTL has set up the image reader on this computer, and how far setting it up got. */
export const ImageReaderSetupStatus = Schema.Struct({
  /** The device setting up installs the reader for, or installed it for. */
  device: ImageReaderDevice,
  /** Why the reader runs on the processor although the computer has an NVIDIA GPU. */
  note: Schema.optionalKey(Schema.String),
  /** About how many bytes setting up downloads, for before it starts. */
  download: Schema.Int,
  ready: Schema.Boolean,
  /** The folder the reader is kept in, on this computer. */
  folder: Schema.String,
  /** Whether that folder exists, set up or left by an attempt that failed. */
  onDisk: Schema.Boolean,
  /**
   * `Idle`, with why the last setting up failed if it did; `SettingUp`; or `Removing` while the
   * reader's folder or its Korean model is deleted.
   */
  phase: Schema.Union([
    Schema.TaggedStruct("Idle", { error: Schema.optionalKey(Schema.String) }),
    Schema.TaggedStruct("SettingUp", {
      step: ImageReaderSetupStep,
      /** The parts of converting the models this setup runs, in order. */
      parts: Schema.Array(ImageReaderModelPart),
      /** The part of converting the models it is on, during the `models` step. */
      part: Schema.optionalKey(ImageReaderModelPart),
      /**
       * While it downloads packages or the LaMa model: the bytes received so far, of the `total`
       * the lockfiles or the download give. Missing while a size is unknown, such as when uv goes
       * through the user's own proxy.
       */
      downloading: Schema.optionalKey(Schema.Struct({ done: Schema.Int, total: Schema.Int })),
    }),
    Schema.TaggedStruct("Removing", {}),
  ]),
  /**
   * The recognizer for Korean text, which the general one can't read. It is set up only when the
   * user asks, with the reader or after it.
   */
  korean: Schema.Struct({
    ready: Schema.Boolean,
    /**
     * About how many bytes setting it up downloads: with the reader, only its model; after it,
     * also the packages that convert it, which the reader's setup deleted.
     */
    download: Schema.Int,
  }),
  /** The address of a reader started outside RPGTL (`RPGTL_IMAGE_READER`), used instead. */
  external: Schema.optionalKey(Schema.String),
  /**
   * How many setups started since RPGTL started. A status sent during or after one has its number,
   * so the page can tell a status from before a setup it asked for.
   */
  attempt: Schema.Int,
});
export type ImageReaderSetupStatus = typeof ImageReaderSetupStatus.Type;
