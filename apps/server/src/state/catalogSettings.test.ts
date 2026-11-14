import { readFileSync } from "node:fs";
import { assert, it } from "@effect/vitest";
import { Catalog } from "@rpgtl/contracts";
import { decodeTranslationFile, importTranslations, inspectedCatalog } from "@rpgtl/domain";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const saved = Schema.decodeUnknownSync(Catalog)(
  JSON.parse(
    readFileSync(
      new URL("formats/2/state/games/4d6f73734c616e746572/catalog.json", import.meta.url),
      "utf8",
    ),
  ),
);

/** The catalog's values besides its lines and runs, which rebuilding and importing work out anew. */
const settings = ({ entries: _entries, runs: _runs, ...rest }: Catalog) => rest;

it("format 2's catalog uses every field of the catalog", () => {
  assert.sameMembers(Object.keys(saved), Object.keys(Catalog.fields));
});

it("reading a game's folder again keeps each of its settings", () => {
  const rebuilt = inspectedCatalog(saved.game, saved.entries, saved);
  assert.deepStrictEqual(settings(rebuilt), settings(saved));
});

it("an import keeps each setting of the game that a translation file doesn't carry", () => {
  const { language, imageBold, imageFont, unchangedImages, ...own } = settings(saved);
  const { version, game, entries, glossary } = saved;
  const file = Result.getOrThrow(
    decodeTranslationFile({
      version,
      game,
      entries,
      glossary,
      translate: !saved.translate,
      language,
      imageBold,
      imageFont,
      unchangedImages,
    }),
  );
  const imported = Result.getOrThrow(importTranslations(saved, file));
  assert.deepInclude(settings(imported), own);
});
