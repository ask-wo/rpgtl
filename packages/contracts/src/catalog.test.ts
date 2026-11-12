import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Catalog } from "./index.ts";

const decode = Schema.decodeUnknownEffect(Catalog);

describe("Catalog", () => {
  it.effect("decodes a catalog file", () =>
    Effect.gen(function* () {
      const catalog = yield* decode({
        version: 1,
        game: { id: "abc", title: "Game", engine: "MV" },
        translate: true,
        entries: [
          {
            id: "e1",
            location: {
              _tag: "Message",
              list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
              index: 0,
            },
            source: "你好",
            translation: { user: "Hello" },
            suggestion: { text: "Hi", reason: "too short" },
          },
        ],
        glossary: [
          {
            source: "美咲",
            translation: { user: "Misaki" },
            kind: { guess: { value: "character" } },
            pronoun: { guess: { value: "she", she: 3, he: 0 } },
          },
        ],
        images: { "img/faces/$Arlene": { file: "Actor1", face: 2 } },
        imageFont: "serif",
      });
      assert.strictEqual(catalog.entries[0]?.suggestion?.reason, "too short");
      assert.strictEqual(catalog.glossary[0]?.pronoun?.guess?.value, "she");
    }),
  );

  it.effect("rejects a term kind it doesn't know", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decode({
          version: 1,
          game: { id: "abc", title: "Game", engine: "MV" },
          entries: [],
          glossary: [{ source: "美咲", translation: {}, kind: { guess: { value: "person" } } }],
        }),
      );
      assert.include(error.message, `["glossary"][0]["kind"]["guess"]["value"]`);
    }),
  );
});
