// The game's catalog as its database in the run's state folder holds it, read without writing.
import { copyFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const file = (state: string, id: string) => `${state}/games/${id}/game.db`;

/**
 * Each entry with its text's source and English in use (`english`, empty without), the glossary
 * with each term's English in use, the game's settings and the kinds of the operations that wrote
 * them, oldest first.
 */
export function savedCatalog(state: string, id: string) {
  const database = new DatabaseSync(file(state, id), { readOnly: true });
  try {
    const all = (query: string) => database.prepare(query).all() as Array<any>;
    return {
      entries: all(
        `select e.id, e.location, e.is_left_untranslated, t.source, t.model_translation,
           t.user_translation
         from entries e join texts t on t.id = e.text_id order by e.position`,
      ).map((row) => ({
        id: row.id,
        location: JSON.parse(row.location),
        source: row.source,
        english: row.user_translation ?? row.model_translation ?? "",
        isLeftUntranslated: row.is_left_untranslated === 1,
      })),
      glossary: all(
        "select source, model_translation, user_translation, user_kind from glossary order by id",
      ).map((row) => ({
        source: row.source,
        english: row.user_translation ?? row.model_translation ?? "",
        userKind: row.user_kind ?? undefined,
      })),
      settings: Object.fromEntries(
        all("select name, value from settings").map((row) => [row.name, JSON.parse(row.value)]),
      ),
      operations: all("select kind from operations order by id").map((row) => row.kind),
    };
  } finally {
    database.close();
  }
}

/** Copies the game's database into the evidence folder as `name`. */
export const keepDatabase = (state: string, id: string, evidence: string, name = "game.db") =>
  copyFileSync(file(state, id), `${evidence}/${name}`);

/**
 * A translation file that gives the texts `english` names the user's English, for Import…; its
 * glossary is `glossary`, each term's English the user's.
 */
export const translationFile = (
  catalog: any,
  english: (source: string) => string | undefined,
  glossary: ReadonlyArray<{ source: string; english: string; kind: string }> = [],
) => ({
  version: 2,
  texts: catalog.texts.flatMap((text: any) => {
    const typed = english(text.source);
    return typed === undefined
      ? []
      : [
          {
            source: text.source,
            ...(text.speaker !== undefined && { speaker: text.speaker }),
            isInImage: text.isInImage,
            userTranslation: typed,
          },
        ];
  }),
  entries: [],
  glossary: glossary.map((term) => ({
    source: term.source,
    userTranslation: term.english,
    rulesKind: term.kind,
  })),
  settings: {},
});
