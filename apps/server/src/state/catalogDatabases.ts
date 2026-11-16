import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import { gameDatabaseMigrations, gameFiles, Location } from "@rpgtl/contracts";
import { fileOf, inspectedEntries, textKey } from "@rpgtl/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as String from "effect/String";
import type { StateFolder } from "./StateFolder.ts";

// The step's own copy of what format 2 stored in `catalog.json`, so it doesn't follow the
// contracts as they change after it.
const opt = Schema.optionalKey;
const Guess = Schema.Struct({
  value: Schema.String,
  run: opt(Schema.String),
  flag: opt(Schema.String),
  long: opt(Schema.String),
});
const OldEntry = Schema.Struct({
  id: Schema.String,
  location: Location,
  source: Schema.String,
  translation: Schema.Struct({ guess: opt(Guess), user: opt(Schema.String) }),
  speaker: opt(Schema.String),
  gameEnglish: opt(Schema.String),
  keepOriginal: opt(Schema.Boolean),
  suggestion: opt(Schema.Struct({ text: Schema.String, reason: Schema.String })),
  previous: opt(Schema.String),
});
type OldEntry = typeof OldEntry.Type;
const OldTerm = Schema.Struct({
  source: Schema.String,
  translation: Schema.Struct({ guess: opt(Guess), user: opt(Schema.String) }),
  kind: Schema.Struct({ guess: Guess, user: opt(Schema.String) }),
  pronoun: opt(
    Schema.Struct({
      guess: opt(Schema.Struct({ ...Guess.fields, she: opt(Schema.Int), he: opt(Schema.Int) })),
      user: opt(Schema.String),
    }),
  ),
  previous: opt(Schema.String),
});
const OldCatalog = Schema.Struct({
  entries: Schema.Array(OldEntry),
  glossary: Schema.Array(OldTerm),
  translate: Schema.Boolean,
  originalScripts: opt(Schema.Boolean),
  disabledFixes: opt(Schema.Array(Schema.String)),
  language: opt(Schema.String),
  imageBold: opt(Schema.Literals(["always", "never"])),
  imageFont: opt(Schema.String),
  unchangedImages: opt(Schema.Array(Schema.String)),
  runs: opt(Schema.Record(Schema.String, Schema.Unknown)),
});
type OldCatalog = typeof OldCatalog.Type;

const firstTables = Object.fromEntries(
  Object.entries(gameDatabaseMigrations)
    .filter(([name]) => name === "1_tables")
    .map(([name, statements]) => [
      name,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const statement of statements) yield* sql.unsafe(statement);
      }),
    ]),
);

const settingsOf = (catalog: OldCatalog): ReadonlyArray<readonly [string, unknown]> => [
  ["isTranslationOn", catalog.translate],
  ...(catalog.originalScripts ? [["isScriptTranslationOn", false] as const] : []),
  ...(catalog.disabledFixes?.length ? [["disabledFixes", catalog.disabledFixes] as const] : []),
  ...(catalog.language ? [["sourceLanguage", catalog.language] as const] : []),
  ...(catalog.imageBold
    ? [["letteringWeight", catalog.imageBold === "always" ? "bold" : "regular"] as const]
    : []),
  ...(catalog.imageFont ? [["letteringFont", catalog.imageFont] as const] : []),
  ...(catalog.unchangedImages?.length
    ? [["untranslatedImages", catalog.unchangedImages] as const]
    : []),
];

/** Writes the catalog's rows into the empty database the client holds. */
const writeRows = Effect.fnUntraced(function* (catalog: OldCatalog) {
  const sql = yield* SqlClient.SqlClient;
  const operation = Effect.fnUntraced(function* (row: Record<string, string | null>) {
    const [inserted] = yield* sql<{ readonly id: number }>`
      insert into operations ${sql.insert(row)} returning id`;
    return inserted?.id ?? 0;
  });
  const runs = new Map<string, number>();
  for (const [startedAt, models] of Object.entries(catalog.runs ?? {}).toSorted(([a], [b]) =>
    a.localeCompare(b),
  ))
    runs.set(
      startedAt,
      yield* operation({ kind: "run", startedAt, models: JSON.stringify(models) }),
    );
  const upgrade = yield* operation({
    kind: "upgrade",
    startedAt: DateTime.formatIso(yield* DateTime.now),
    models: null,
  });
  const writer = (guess: { readonly run?: string } | undefined) =>
    (guess?.run && runs.get(guess.run)) || upgrade;
  /**
   * Gives the new row, still without English, its values: the model's under the run that gave
   * them, the user's under the upgrade. English from before it was cleared is recorded first, as a
   * clear records it.
   */
  const written = Effect.fnUntraced(function* (
    table: "texts" | "glossary",
    id: number,
    previous: string | undefined,
    model: { readonly values: Record<string, string | null>; readonly run: number },
    user: Record<string, string | null>,
  ) {
    if (previous) {
      yield* sql`update ${sql(table)} set model_translation = ${previous} where id = ${id}`;
      yield* sql`update ${sql(table)} set model_translation = null where id = ${id}`;
    }
    yield* sql`update ${sql(table)} set ${sql.update({ ...model.values, lastOperationId: model.run })}
      where id = ${id}`;
    yield* sql`update ${sql(table)} set ${sql.update({ ...user, lastOperationId: upgrade })}
      where id = ${id}`;
  });

  const read = inspectedEntries(
    catalog.entries.map((entry) => ({
      id: entry.id,
      location: entry.location,
      source: entry.source,
      ...(entry.speaker !== undefined && { speaker: entry.speaker }),
    })),
    undefined,
  );
  const byKey = new Map<string, Array<OldEntry>>();
  for (const [index, entry] of catalog.entries.entries()) {
    const key = textKey(read[index] ?? { ...entry, isInImage: false });
    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  }
  const textIds = new Map<string, number>();
  for (const [index, entry] of catalog.entries.entries()) {
    const keyed = read[index];
    if (!keyed) continue;
    const key = textKey(keyed);
    if (textIds.has(key)) continue;
    // Format 2 kept English per entry, so copies of one text may disagree: each value comes from
    // the first copy that has one.
    const same = byKey.get(key) ?? [entry];
    const guess = same.find((each) => each.translation.guess?.value)?.translation.guess;
    const user = same.find((each) => each.translation.user !== undefined)?.translation.user;
    const suggestion = same.find((each) => each.suggestion)?.suggestion;
    const [row] = yield* sql<{ readonly id: number }>`insert into texts ${sql.insert({
      source: keyed.source,
      speaker: keyed.speaker ?? null,
      isInImage: keyed.isInImage ? 1 : 0,
      lastOperationId: upgrade,
    })} returning id`;
    const id = row?.id ?? 0;
    textIds.set(key, id);
    yield* written(
      "texts",
      id,
      same.find((each) => each.previous)?.previous,
      {
        values: {
          modelTranslation: guess?.value || null,
          unshortenedTranslation: guess?.long ?? null,
          flagReason: guess?.flag ?? null,
        },
        run: writer(guess),
      },
      {
        rejectedTranslation: suggestion?.text ?? null,
        rejectionReason: suggestion?.reason ?? null,
        userTranslation: user ?? null,
      },
    );
  }
  for (const [position, entry] of catalog.entries.entries()) {
    const keyed = read[position];
    const textId = keyed && textIds.get(textKey(keyed));
    if (textId === undefined) continue;
    yield* sql`insert into entries ${sql.insert({
      id: entry.id,
      textId,
      position,
      place: fileOf(entry.location),
      location: JSON.stringify(entry.location),
      builtinTranslation: entry.gameEnglish ?? null,
      isLeftUntranslated: entry.keepOriginal ? 1 : 0,
    })}`;
  }
  for (const term of catalog.glossary) {
    const { guess, user } = term.translation;
    const kind = term.kind.guess;
    const pronoun = term.pronoun?.guess;
    const [row] = yield* sql<{ readonly id: number }>`insert into glossary ${sql.insert({
      source: term.source,
      rulesKind: kind.value,
      modelKind: kind.run ? kind.value : null,
      userKind: term.kind.user ?? null,
      rulesPronoun: pronoun && !pronoun.run ? pronoun.value : null,
      sheClues: pronoun?.she ?? null,
      heClues: pronoun?.he ?? null,
      modelPronoun: pronoun?.run ? pronoun.value : null,
      userPronoun: term.pronoun?.user ?? null,
      lastOperationId: upgrade,
    })} returning id`;
    yield* written(
      "glossary",
      row?.id ?? 0,
      term.previous,
      { values: { modelTranslation: guess?.value || null }, run: writer(guess) },
      { userTranslation: user || null },
    );
  }
  for (const [name, value] of settingsOf(catalog))
    yield* sql`insert into settings ${sql.insert({ name, value: JSON.stringify(value) })}`;
});

/**
 * Format 2 kept each game's text, translations and settings in `catalog.json`; format 3 keeps them
 * in the game's database. The runs that wrote translations become run operations, so each English
 * keeps the run it came from.
 */
export const catalogDatabases = Effect.fn("catalogDatabases")(function* (
  folder: StateFolder["Service"],
) {
  for (const id of yield* folder.list("games")) {
    const files = gameFiles(id);
    const saved = yield* folder.read(files.catalog, OldCatalog);
    if (Option.isNone(saved)) continue;
    const filename = `${folder.root}/${files.database}`;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(firstTables) });
      const [written] = yield* sql<{ readonly count: number }>`
        select count(*) as count from operations`;
      // A step stopped after its transaction already wrote this game.
      if ((written?.count ?? 0) > 0) return;
      yield* sql.withTransaction(writeRows(saved.value));
    }).pipe(
      Effect.provideServiceEffect(
        SqlClient.SqlClient,
        SqliteClient.make({
          filename,
          transformQueryNames: String.camelToSnake,
          transformResultNames: String.snakeToCamel,
        }),
      ),
      Effect.scoped,
      Effect.provideServiceEffect(Reactivity.Reactivity, Reactivity.make),
      Effect.orDie,
    );
    yield* folder.remove(files.catalog);
  }
});
