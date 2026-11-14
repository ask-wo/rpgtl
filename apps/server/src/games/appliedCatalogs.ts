import { Catalog, Games } from "@rpgtl/contracts";
import {
  applyPluginTranslations,
  applyTranslations,
  decodeGameFile,
  patchXpFile,
  translatedByXpFile,
} from "@rpgtl/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { Decoded } from "../state/decodeStateFolder.ts";
import * as StateFolder from "../state/StateFolder.ts";
import { type FolderGame, GameFolder } from "./GameFolder.ts";

/** The game's data files that its catalog no longer applies to, by name. */
const unapplied = Effect.fnUntraced(function* (game: FolderGame, catalog: Catalog) {
  const gameFolder = yield* GameFolder;
  const failed: Array<string> = [];
  if (game.engine === "XP") {
    const files = yield* gameFolder.xpData(game);
    for (const [name, entries] of translatedByXpFile(catalog)) {
      const bytes = files.get(name);
      if (bytes && Result.isFailure(patchXpFile(name, bytes, entries, []))) failed.push(name);
    }
    return failed;
  }
  const contents = yield* gameFolder.contents(game);
  for (const { name } of contents.dataFiles) {
    const raw = new TextDecoder().decode(yield* gameFolder.readFile(game, `data/${name}`));
    const applied = Result.flatMap(decodeGameFile(name, raw), (file) =>
      applyTranslations(name, file, catalog.entries),
    );
    if (Result.isFailure(applied)) failed.push(name);
  }
  if (Result.isFailure(applyPluginTranslations(contents.plugins, catalog.entries)))
    failed.push("plugins.js");
  return failed;
});

// The decoding of the state folder reports a state file that doesn't decode.
const unread = () => Effect.succeedNone;

/**
 * Applies each saved catalog to its game's files as playing does, without writing anything. A file
 * whose text no longer holds an entry's source plays untranslated, as when the rules that extract
 * the text changed an entry's source without the game being read again.
 */
export const appliedCatalogs = Effect.fn("appliedCatalogs")(function* () {
  const folder = yield* StateFolder.StateFolder;
  const games = Option.getOrElse(
    yield* folder.read("games.json", Games).pipe(Effect.catchTags({ StateFileError: unread })),
    () => [],
  );
  const results: Array<Decoded> = [];
  for (const { id, ...game } of games) {
    const file = `games/${id} applied to ${game.root}`;
    const catalog = yield* folder
      .read(`games/${id}/catalog.json`, Catalog)
      .pipe(Effect.catchTags({ StateFileError: unread }));
    if (Option.isNone(catalog)) continue;
    const result = yield* unapplied(game, catalog.value).pipe(
      Effect.map((failed): Decoded =>
        failed.length
          ? { file, problem: `no longer holds an entry's source: ${failed.join(", ")}` }
          : { file },
      ),
      Effect.catchTags({
        GameFileReadError: (error) => Effect.succeed({ file, problem: String(error.cause) }),
        GameFileInvalid: (error) => Effect.succeed({ file, problem: error.message }),
      }),
    );
    results.push(result);
  }
  return results;
});
