import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import {
  type Catalog,
  type Entry,
  GameSettings,
  type GlossaryTerm,
  Location,
  type Operation,
  type OperationKind,
  type RunModels,
  RunModels as RunModelsSchema,
  Text as TextSchema,
  type Text,
  GlossaryTerm as GlossaryTermSchema,
  termColumns,
  textColumns,
} from "@rpgtl/contracts";
import { fileOf, splitVersion, textKey } from "@rpgtl/domain";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as String from "effect/String";
import * as Reactivity from "effect/reactivity/Reactivity";

type Nullable<T> = { readonly [K in keyof T]-?: Exclude<T[K], undefined> | null };

/** The row's columns that hold a value, as the schemas leave a missing value out. */
const present = (row: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));

const nulls = <K extends string>(columns: ReadonlyArray<K>, value: Partial<Record<K, unknown>>) =>
  Object.fromEntries(columns.map((column) => [column, value[column] ?? null]));

const columnList = (sql: SqlClient.SqlClient, columns: ReadonlyArray<string>) =>
  sql.literal(columns.map(String.camelToSnake).join(", "));

// The triggers credit each change of a text or term to the row's `last_operation_id`, also when the
// row is deleted, so every update and delete sets it to the writing operation first.
const updateRow = Effect.fnUntraced(function* (
  table: "texts" | "glossary",
  id: number,
  values: Readonly<Record<string, unknown>>,
  operationId: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`update ${sql(table)} set ${sql.update({ ...values, lastOperationId: operationId })}
    where id = ${id}`;
});

const deleteTerms = Effect.fnUntraced(function* (ids: ReadonlyArray<number>, operationId: number) {
  const sql = yield* SqlClient.SqlClient;
  for (const chunk of Arr.chunksOf(ids, 500)) {
    yield* sql`update glossary set last_operation_id = ${operationId} where ${sql.in("id", chunk)}`;
    yield* sql`delete from glossary where ${sql.in("id", chunk)}`;
  }
});

const decodeLocation = Schema.decodeSync(Schema.fromJsonString(Location));
const encodeLocation = Schema.encodeSync(Schema.fromJsonString(Location));
const decodeModels = Schema.decodeSync(Schema.fromJsonString(RunModelsSchema));
const encodeModels = Schema.encodeSync(Schema.fromJsonString(RunModelsSchema));
const decodeSettings = Schema.decodeUnknownSync(GameSettings);
const decodeText = Schema.decodeUnknownSync(TextSchema);
const decodeTerm = Schema.decodeUnknownSync(GlossaryTermSchema);
const encodeSettings = Schema.encodeSync(GameSettings);

/** Per row of `table`, the operation that last wrote its model translation. */
const modelWriters = Effect.fnUntraced(function* (table: "texts" | "glossary") {
  const sql = yield* SqlClient.SqlClient;
  // SQLite gives the bare `operation_id` of the row with the largest id in each group.
  const rows = yield* sql<{ readonly rowId: number; readonly operationId: number }>`
    select row_id, operation_id, max(id) from changes
    where table_name = ${table}
      and (column_name = 'model_translation'
        or (column_name is null and new_value ->> '$.model_translation' is not null))
    group by row_id`;
  return new Map(rows.map((row) => [row.rowId, row.operationId]));
});

/**
 * Per row of `table`, the translation in use before it was last cleared, and whether the user
 * cleared it in an edit. The upgrade from catalog files records an old file's English from before
 * a clear as one of its changes.
 */
const clearedTranslations = Effect.fnUntraced(function* (table: "texts" | "glossary") {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly rowId: number;
    readonly operationId: number;
    readonly columnName: string;
    readonly oldValue: string;
    readonly kind: OperationKind;
  }>`
    select c.row_id, c.operation_id, c.column_name, c.old_value, o.kind from changes c
    join operations o on o.id = c.operation_id
    where c.table_name = ${table}
      and c.column_name in ('model_translation', 'user_translation')
      and c.old_value is not null and c.new_value is null
      and o.kind in ('clear', 'upgrade', 'edit')
    order by c.id desc`;
  const latest = new Map<
    number,
    { operationId: number; value: string; user: boolean; isEdit: boolean }
  >();
  for (const row of rows) {
    const user = row.columnName === "user_translation";
    const known = latest.get(row.rowId);
    if (!known)
      latest.set(row.rowId, {
        operationId: row.operationId,
        value: row.oldValue,
        user,
        isEdit: row.kind === "edit",
      });
    else if (known.operationId === row.operationId && user && !known.user)
      latest.set(row.rowId, { ...known, value: row.oldValue, user });
  }
  return latest;
});

/** The game's catalog as its database holds it; none before the game was first read. */
export const readCatalog = (game: Catalog["game"]) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(readRows(game)));

const readRows = Effect.fn("catalogRows.readCatalog")(function* (game: Catalog["game"]) {
  const sql = yield* SqlClient.SqlClient;
  const operationRows = yield* sql<{
    readonly id: number;
    readonly kind: OperationKind;
    readonly startedAt: string;
    readonly models: string | null;
  }>`select id, kind, started_at, models from operations order by id`;
  if (operationRows.length === 0) return undefined;
  const operations = operationRows.map(({ models, ...operation }): Operation => ({
    ...operation,
    ...(models !== null && { models: decodeModels(models) }),
  }));
  const writers = {
    texts: yield* modelWriters("texts"),
    glossary: yield* modelWriters("glossary"),
  };
  const before = {
    texts: yield* clearedTranslations("texts"),
    glossary: yield* clearedTranslations("glossary"),
  };
  const derived = (
    table: "texts" | "glossary",
    row: { readonly id: number } & Nullable<Pick<Text, "modelTranslation" | "userTranslation">>,
  ) => {
    const modelOperationId = row.modelTranslation === null ? undefined : writers[table].get(row.id);
    const cleared = before[table].get(row.id);
    // An edit that empties the user's English while the model's, written before it, stays in use,
    // as Use it does, clears nothing.
    const isUseIt =
      cleared?.isEdit === true &&
      row.modelTranslation !== null &&
      (modelOperationId ?? 0) < cleared.operationId;
    const previousTranslation =
      cleared === undefined ||
      isUseIt ||
      cleared.value === (row.userTranslation ?? row.modelTranslation)
        ? undefined
        : cleared.value;
    return {
      ...(modelOperationId !== undefined && { modelOperationId }),
      ...(previousTranslation !== undefined && { previousTranslation }),
    };
  };
  const textRows = yield* sql<
    Nullable<Omit<Text, "id" | "isInImage">> & { readonly id: number; readonly isInImage: number }
  >`
    select id, source, speaker, is_in_image, ${columnList(sql, textColumns)}
    from texts order by id`;
  const texts = textRows.map(({ isInImage, ...row }) =>
    decodeText({
      ...present(row),
      isInImage: isInImage === 1,
      ...derived("texts", row),
    }),
  );
  // Read-only readers open databases the server hasn't migrated yet, which lack later columns.
  const entryRows = yield* sql<{
    readonly id: string;
    readonly textId: number;
    readonly location: string;
    readonly builtinTranslation: string | null;
    readonly code?: string | null;
    readonly isLeftUntranslated: number;
  }>`select * from entries order by position`;
  const entries = entryRows.map((row): Entry => ({
    id: row.id,
    textId: row.textId,
    location: decodeLocation(row.location),
    ...(row.builtinTranslation !== null && { builtinTranslation: row.builtinTranslation }),
    ...(typeof row.code === "string" && { code: row.code }),
    ...(row.isLeftUntranslated === 1 && { isLeftUntranslated: true }),
  }));
  const termRows = yield* sql<Nullable<Omit<GlossaryTerm, "id">> & { readonly id: number }>`
    select id, ${columnList(sql, termColumns)} from glossary order by id`;
  const glossary = termRows.map((row) =>
    decodeTerm({
      ...present(row),
      ...derived("glossary", row),
    }),
  );
  const settingRows = yield* sql<{ readonly name: string; readonly value: string }>`
    select name, value from settings`;
  const settings = decodeSettings(
    Object.fromEntries(settingRows.map(({ name, value }) => [name, JSON.parse(value)])),
  );
  return { game, entries, texts, glossary, settings, operations } satisfies Catalog;
});

/**
 * Runs `write` with a new operation of `kind` in one transaction, so a failure or a stop leaves
 * none of it written, and gives the operation's id.
 */
export const writeOperation = Effect.fn("catalogRows.writeOperation")(function* <E, R>(
  kind: OperationKind,
  write: (operationId: number) => Effect.Effect<void, E, R>,
  models?: RunModels,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const operationId = yield* startOperation(kind, models);
      yield* write(operationId);
      return operationId;
    }),
  );
});

/** The English of the game's title, without the version a title may end with. */
export const readTitleTranslation = Effect.fn("catalogRows.readTitleTranslation")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    readonly userTranslation: string | null;
    readonly modelTranslation: string | null;
  }>`
    select t.user_translation, t.model_translation from entries e join texts t on t.id = e.text_id
    where e.location ->> '$._tag' = 'SystemText' and e.location -> '$.keys' = '["gameTitle"]'`;
  const english = row?.userTranslation ?? row?.modelTranslation;
  return english ? splitVersion(english).name.trim() || undefined : undefined;
});

/**
 * The catalog in the game database at `file`, opened read-only so nothing is written to it; none
 * before the game was first read.
 */
export const readCatalogAt = Effect.fn("catalogRows.readCatalogAt")(
  function* (file: string, game: Catalog["game"]) {
    const client = yield* SqliteClient.make({
      filename: file,
      readonly: true,
      disableWAL: true,
      transformQueryNames: String.camelToSnake,
      transformResultNames: String.snakeToCamel,
    });
    return yield* readCatalog(game).pipe(Effect.provideService(SqlClient.SqlClient, client));
  },
  Effect.scoped,
  Effect.provideServiceEffect(Reactivity.Reactivity, Reactivity.make),
);

/** Starts an operation of `kind` and gives its id. */
export const startOperation = Effect.fn("catalogRows.startOperation")(function* (
  kind: OperationKind,
  models?: RunModels,
) {
  const sql = yield* SqlClient.SqlClient;
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const [row] = yield* sql<{ readonly id: number }>`
    insert into operations ${sql.insert({
      kind,
      startedAt,
      models: models ? encodeModels(models) : null,
    })} returning id`;
  if (!row) return yield* Effect.die(new Error("SQLite gave no id for the new operation."));
  return row.id;
});

const insertText = Effect.fnUntraced(function* (text: Text, operationId: number) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly id: number }>`
    insert into texts ${sql.insert({
      source: text.source,
      speaker: text.speaker ?? null,
      isInImage: text.isInImage ? 1 : 0,
      ...nulls(textColumns, text),
      lastOperationId: operationId,
    })} returning id`;
  if (!row) return yield* Effect.die(new Error("SQLite gave no id for the new text."));
  return row.id;
});

const sameValues = <K extends string>(
  columns: ReadonlyArray<K>,
  a: Partial<Record<K, unknown>>,
  b: Partial<Record<K, unknown>>,
) => columns.every((column) => (a[column] ?? null) === (b[column] ?? null));

const entryRow = (entry: Entry, position: number) => ({
  id: entry.id,
  textId: entry.textId,
  position,
  place: fileOf(entry.location),
  location: encodeLocation(entry.location),
  builtinTranslation: entry.builtinTranslation ?? null,
  code: entry.code ?? null,
  isLeftUntranslated: entry.isLeftUntranslated ? 1 : 0,
});

const upsertEntries = Effect.fnUntraced(function* (
  entries: ReadonlyArray<readonly [position: number, entry: Entry]>,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const chunk of Arr.chunksOf(entries, 500)) {
    if (!Arr.isReadonlyArrayNonEmpty(chunk)) continue;
    yield* sql`insert into entries ${sql.insert(Arr.map(chunk, ([position, entry]) => entryRow(entry, position)))}
      on conflict (id) do update set text_id = excluded.text_id, position = excluded.position,
        place = excluded.place, location = excluded.location,
        builtin_translation = excluded.builtin_translation, code = excluded.code,
        is_left_untranslated = excluded.is_left_untranslated`;
  }
});

const sameEntry = (a: Entry, b: Entry) =>
  a.textId === b.textId &&
  (a.isLeftUntranslated ?? false) === (b.isLeftUntranslated ?? false) &&
  (a.builtinTranslation ?? null) === (b.builtinTranslation ?? null) &&
  (a.code ?? null) === (b.code ?? null) &&
  JSON.stringify(a.location) === JSON.stringify(b.location);

/**
 * Writes what `next` changes from `before`, the catalog as read, under the operation: texts, terms
 * and entries added, changed and dropped, and the settings. Texts and terms of an id below 0 are
 * new. Texts stay when no entry uses them any more, with their English.
 */
export const writeChanged = Effect.fn("catalogRows.writeChanged")(function* (
  before: Catalog,
  next: Pick<Catalog, "entries" | "texts" | "glossary" | "settings">,
  operationId: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const ids = new Map<number, number>();
  const oldTexts = new Map(before.texts.map((text) => [text.id, text]));
  for (const text of next.texts) {
    if (text.id < 0) {
      ids.set(text.id, yield* insertText(text, operationId));
      continue;
    }
    const old = oldTexts.get(text.id);
    if (old === undefined) return yield* Effect.die(new Error(`No saved text has id ${text.id}.`));
    if (text === old || sameValues(textColumns, text, old)) continue;
    yield* updateRow("texts", text.id, nulls(textColumns, text), operationId);
  }
  const oldEntries = new Map(before.entries.map((entry) => [entry.id, entry]));
  const kept = new Set<string>();
  const oldPositions = new Map(before.entries.map((entry, position) => [entry.id, position]));
  const changedEntries: Array<readonly [number, Entry]> = [];
  for (const [position, entry] of next.entries.entries()) {
    kept.add(entry.id);
    const placed = { ...entry, textId: ids.get(entry.textId) ?? entry.textId };
    const old = oldEntries.get(entry.id);
    if (
      old !== undefined &&
      oldPositions.get(entry.id) === position &&
      (entry === old || sameEntry(placed, old))
    )
      continue;
    changedEntries.push([position, placed]);
  }
  yield* upsertEntries(changedEntries);
  const dropped = before.entries.filter((entry) => !kept.has(entry.id)).map((entry) => entry.id);
  for (const chunk of Arr.chunksOf(dropped, 500))
    yield* sql`delete from entries where ${sql.in("id", chunk)}`;
  const oldTerms = new Map(before.glossary.map((term) => [term.id, term]));
  const keptTerms = new Set<number>();
  for (const term of next.glossary) {
    if (term.id < 0) {
      yield* sql`insert into glossary ${sql.insert({
        ...nulls(termColumns, term),
        lastOperationId: operationId,
      })}`;
      continue;
    }
    const old = oldTerms.get(term.id);
    if (old === undefined) return yield* Effect.die(new Error(`No saved term has id ${term.id}.`));
    keptTerms.add(term.id);
    if (term === old || sameValues(termColumns, term, old)) continue;
    yield* updateRow("glossary", term.id, nulls(termColumns, term), operationId);
  }
  yield* deleteTerms(
    before.glossary.filter((term) => !keptTerms.has(term.id)).map((term) => term.id),
    operationId,
  );
  yield* writeSettings(before.settings, next.settings);
});

/** Writes the settings that differ from `before`, leaving defaults unsaved. */
const writeSettings = Effect.fn("catalogRows.writeSettings")(function* (
  before: GameSettings,
  next: GameSettings,
) {
  const sql = yield* SqlClient.SqlClient;
  const old: Record<string, unknown> = encodeSettings(before);
  const encoded: Record<string, unknown> = encodeSettings(next);
  for (const name of new Set([...Object.keys(old), ...Object.keys(encoded)])) {
    const value = encoded[name];
    if (JSON.stringify(value) === JSON.stringify(old[name])) continue;
    if (value === undefined) yield* sql`delete from settings where name = ${name}`;
    else
      yield* sql`insert into settings ${sql.insert({ name, value: JSON.stringify(value) })}
        on conflict (name) do update set value = excluded.value`;
  }
});

/** A text a run changed, by id, with its values. */
export type ChangedText = Pick<Text, "id"> & Partial<Pick<Text, (typeof textColumns)[number]>>;

/**
 * Writes the texts and terms a run changed under its operation. A term of an id below 0 is new,
 * and gets its id on the next read.
 */
export const writeRunChanges = Effect.fn("catalogRows.writeRunChanges")(function* (
  changes: {
    readonly texts: ReadonlyArray<ChangedText>;
    readonly terms: ReadonlyArray<GlossaryTerm>;
  },
  operationId: number,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const text of changes.texts)
    yield* updateRow("texts", text.id, nulls(textColumns, text), operationId);
  for (const term of changes.terms) {
    if (term.id >= 0) {
      yield* updateRow("glossary", term.id, nulls(termColumns, term), operationId);
      continue;
    }
    const values = {
      ...nulls(
        termColumns.filter((column) => column !== "source"),
        term,
      ),
      lastOperationId: operationId,
    };
    yield* sql`insert into glossary ${sql.insert({ ...values, source: term.source })}
      on conflict (source) do update set ${sql.update(values)}`;
  }
});

/**
 * Puts the entries the game reads as now into the database under the operation: each gets the
 * text of its source, speaker and image flag, added without English when there is none, and
 * entries no longer read go. Settings the user chose on an entry stay with its id.
 */
export const writeInspected = Effect.fn("catalogRows.writeInspected")(function* (
  read: ReadonlyArray<
    Omit<Entry, "textId"> & Pick<Text, "source" | "isInImage"> & Partial<Pick<Text, "speaker">>
  >,
  operationId: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const keys = new Map(read.map((entry) => [textKey(entry), entry]));
  for (const chunk of Arr.chunksOf([...keys.values()], 500)) {
    if (!Arr.isReadonlyArrayNonEmpty(chunk)) continue;
    yield* sql`insert into texts ${sql.insert(
      Arr.map(chunk, (entry) => ({
        source: entry.source,
        speaker: entry.speaker ?? null,
        isInImage: entry.isInImage ? 1 : 0,
        lastOperationId: operationId,
      })),
    )} on conflict (source, ifnull(speaker, ''), is_in_image) do nothing`;
  }
  const textRows = yield* sql<{
    readonly id: number;
    readonly source: string;
    readonly speaker: string | null;
    readonly isInImage: number;
  }>`select id, source, speaker, is_in_image from texts`;
  const textIds = new Map(
    textRows.map((row) => [
      textKey({
        source: row.source,
        isInImage: row.isInImage === 1,
        ...(row.speaker !== null && { speaker: row.speaker }),
      }),
      row.id,
    ]),
  );
  const entries = read.flatMap((entry): ReadonlyArray<Entry> => {
    const textId = textIds.get(textKey(entry));
    if (textId === undefined) return [];
    const { source: _, isInImage: __, speaker: ___, ...placed } = entry;
    return [{ ...placed, textId }];
  });
  yield* sql`create temp table if not exists read_entries (id text primary key)`;
  yield* sql`delete from read_entries`;
  for (const chunk of Arr.chunksOf(entries, 500)) {
    if (!Arr.isReadonlyArrayNonEmpty(chunk)) continue;
    yield* sql`insert into read_entries ${sql.insert(Arr.map(chunk, ({ id }) => ({ id })))}`;
  }
  yield* upsertEntries([...entries.entries()]);
  yield* sql`delete from entries where id not in (select id from read_entries)`;
  yield* sql`drop table read_entries`;
});
