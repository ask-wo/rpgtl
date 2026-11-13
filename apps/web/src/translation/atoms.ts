import { Catalog, ExportedImageText, GameNotInspected, StateFileFailed } from "@rpgtl/contracts";
import { type CheckedCatalog, exportedRuns, withCatalogChange } from "@rpgtl/domain";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";
import * as Reactivity from "effect/reactivity/Reactivity";
import { following } from "../app/following.ts";
import { Rpgtl } from "../app/Rpgtl.ts";

/** Refreshed by every change to the game's catalog, such as the games list's English titles. */
export const catalogKey = (id: string) => ({ catalog: [id] });
/**
 * Refreshed by every change to what reading the game's images found: a reading, Clear image text,
 * an import. Edits to the catalog leave it alone, so a save doesn't fetch every image's read again.
 */
export const imageResultsKey = (id: string) => ({ imageResults: [id] });

/**
 * The game's catalog and what the checks find in it, as the server sends them: whole at first,
 * then the entries each write changes, so a run's batch doesn't fetch the whole catalog again.
 * A large game's whole catalog is over the 10 MiB that Effect's SSE parser takes by default, and
 * `following` would then fetch it again every second without ever showing it.
 */
const followed = Atom.family((id: string) =>
  Rpgtl.runtime.atom(
    following(
      Stream.unwrap(
        Rpgtl.use((client) =>
          client.catalogs.changes({ query: { id }, sseOptions: { maxEventSize: Infinity } }),
        ),
      ),
      Schema.is(Schema.Union([GameNotInspected, StateFileFailed])),
    ).pipe(
      Stream.mapAccum(
        (): CheckedCatalog | undefined => undefined,
        (previous, change) => {
          const next = withCatalogChange(previous, change);
          return [next, next ? [next] : []];
        },
      ),
    ),
  ),
);

export const catalog = Atom.family((id: string) =>
  Atom.map(
    followed(id),
    AsyncResult.map((now) => now.catalog),
  ),
);
/** What the translation checks find in the game's catalog. */
export const findings = Atom.family((id: string) =>
  Atom.map(
    followed(id),
    AsyncResult.map((now) => now.findings),
  ),
);

/** Reads every query keyed on `catalogKey` again. */
export const invalidateCatalog = Rpgtl.runtime.fn((id: string) =>
  Reactivity.invalidate(catalogKey(id)),
);

export const setTranslate = Rpgtl.mutation("catalogs", "setTranslate");
export const setLanguage = Rpgtl.mutation("catalogs", "setLanguage");
export const setOriginalScripts = Rpgtl.mutation("catalogs", "setOriginalScripts");
export const importFile = Rpgtl.mutation("catalogs", "import");
export const previewImport = Rpgtl.mutation("catalogs", "previewImport");
export const clearAll = Rpgtl.mutation("catalogs", "restore");
export const translate = Rpgtl.mutation("translation", "start");
export const stopTranslating = Rpgtl.mutation("translation", "stop");
export const stopReadingImages = Rpgtl.mutation("images", "stop");

/**
 * The saved catalog, its images' read results and the runs that made them, encoded as Export
 * writes them into a translation file: the erased backgrounds' patches as base64 again, since the
 * client decodes them into bytes.
 */
export const translationFile = Rpgtl.runtime.fn((id: string) =>
  Rpgtl.use((client) =>
    Effect.all([
      client.catalogs.get({ query: { id } }),
      client.images.export({ query: { id } }),
    ]).pipe(
      Effect.flatMap(([saved, images]) =>
        Effect.all([
          Schema.encodeEffect(Catalog)(saved),
          Schema.encodeEffect(Schema.NullOr(ExportedImageText))(images),
        ]).pipe(
          Effect.map(([encoded, imageText]) => ({
            ...Struct.omit(encoded, ["runs"]),
            ...exportedRuns(saved, images ?? undefined),
            ...(imageText && { images: imageText.images }),
          })),
        ),
      ),
    ),
  ),
);

/** The models installed in the Ollama server at the endpoint. */
export const ollamaModels = (endpoint: string) =>
  Rpgtl.query("ollama", "models", { query: { endpoint } });

/** The models the Claude or Codex CLI offers its login now, with their effort levels. */
export const agentModels = (translator: "claude" | "codex") =>
  Rpgtl.query("agents", "models", { query: { translator } });

/** Whether expert layers in system RAM work on this system. */
export const llamaServer = Rpgtl.query("ollama", "llamaServer", {});

/** How many layers an Ollama model has, and how many experts each. */
export const modelInfo = (endpoint: string, model: string) =>
  Rpgtl.query("ollama", "modelInfo", { query: { endpoint, model } });
