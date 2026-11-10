import {
  applyPluginTranslations,
  applyTranslations,
  decodeGameFile,
  decodePlugins,
  encodePlugins,
  type GameDataChanged,
  type GameFileInvalid,
  imageTextHints,
  translatedImageNames,
  withSystemImages,
} from "@rpgtl/domain";
import type { Catalog } from "@rpgtl/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Catalogs from "../games/Catalogs.ts";
import * as GameFolder from "../games/GameFolder.ts";
import * as Games from "../games/Games.ts";
import * as ImageTexts from "../imageText/ImageTexts.ts";
import * as Settings from "../settings/Settings.ts";
import type * as StateFolder from "../state/StateFolder.ts";
import { displayFlags } from "./displayFlags.ts";

/** A file of a played game: one in the game folder as it is, or one RPGTL made from it. */
export type PlayFile = Data.TaggedEnum<{
  Stored: { readonly path: string };
  Made: { readonly text: string; readonly contentType: string };
}>;
export const PlayFile = Data.taggedEnum<PlayFile>();

const dataFile = /^data\/[^/]+\.json$/;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * The games as the browser plays them: their own files, with the game runtime in `index.html` and,
 * while the game's translation switch is on, the catalog's translations in the data files and
 * plugin settings, and in `System.json` the images to load under translated names and to draw
 * English into.
 */
export class Play extends Context.Service<
  Play,
  {
    /** The game's file at `relative` below its web folder, in any letter case. */
    readonly file: (
      id: string,
      relative: string,
    ) => Effect.Effect<
      PlayFile,
      | Games.GameNotInspectedError
      | GameFolder.GameFileMissingError
      | GameFolder.GameFileReadError
      | GameFileInvalid
      | GameDataChanged
      | StateFolder.StateFileError
    >;
    /** The erased background `name` the reader saved for the game; none without one. */
    readonly erasedImage: (
      id: string,
      name: string,
    ) => Effect.Effect<
      Option.Option<string>,
      Games.GameNotInspectedError | StateFolder.StateFileError
    >;
  }
>()("@rpgtl/server/play/Play") {}

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const games = yield* Games.Games;
  const gameFolder = yield* GameFolder.GameFolder;
  const catalogs = yield* Catalogs.Catalogs;
  const imageTexts = yield* ImageTexts.ImageTexts;
  const settings = yield* Settings.Settings;

  const page = Effect.fnUntraced(function* (id: string, html: string) {
    const scripts =
      `<script>${displayFlags(yield* settings.get)}</script>` +
      `<script src="/runtime.js" data-game="${id}"></script><script src="/map-view.js"></script>`;
    return PlayFile.Made({
      text: html.includes("</body>")
        ? html.replace("</body>", `${scripts}</body>`)
        : html + scripts,
      contentType: "text/html; charset=utf-8",
    });
  });

  /** A data file as the game plays it; with the switch off, only System.json changes. */
  const playedData = Effect.fnUntraced(function* (
    id: string,
    catalog: Catalog,
    relative: string,
    raw: string,
  ) {
    const name = path.basename(relative);
    const data = yield* Effect.fromResult(decodeGameFile(name, raw));
    if (!catalog.translate) return data.data;
    const translated = yield* Effect.fromResult(applyTranslations(name, data, catalog.entries));
    if (translated._tag !== "System") return translated.data;
    const game = yield* games.get(id);
    const withImages = withSystemImages(translated, {
      images: translatedImageNames(yield* gameFolder.images(game), catalog.entries),
      imageText: imageTextHints(
        yield* imageTexts.results(id),
        catalog,
        (erased) => `/erased/${id}/${erased}`,
      ),
    });
    return withImages.data;
  });

  const translatedPlugins = Effect.fnUntraced(function* ({ entries }: Catalog, raw: string) {
    const plugins = yield* Effect.fromResult(decodePlugins(raw));
    return encodePlugins(yield* Effect.fromResult(applyPluginTranslations(plugins, entries)));
  });

  const file = Effect.fn("Play.file")(function* (id: string, relative: string) {
    const game = yield* games.get(id);
    const found = yield* gameFolder.find(game, relative || "index.html");
    const below = path.relative(game.webRoot, found).split(path.sep).join("/");
    if (below === "index.html")
      return yield* page(id, text(yield* gameFolder.readFile(game, below)));
    const isData = dataFile.test(below);
    if (!isData && below !== "js/plugins.js") return PlayFile.Stored({ path: found });
    const catalog = yield* catalogs.get(id);
    const on = catalog.translate;
    if (isData && (on || path.basename(below) === "System.json")) {
      const raw = text(yield* gameFolder.readFile(game, below));
      return PlayFile.Made({
        text: JSON.stringify(yield* playedData(id, catalog, below, raw)),
        contentType: "application/json; charset=utf-8",
      });
    }
    if (on && !isData)
      return PlayFile.Made({
        text: yield* translatedPlugins(catalog, text(yield* gameFolder.readFile(game, below))),
        contentType: "text/javascript; charset=utf-8",
      });
    return PlayFile.Stored({ path: found });
  });

  const erasedImage = Effect.fn("Play.erasedImage")(function* (id: string, name: string) {
    yield* games.get(id);
    return yield* imageTexts.erasedImage(id, name);
  });

  return Play.of({ file, erasedImage });
});

export const layer = Layer.effect(Play, make);
