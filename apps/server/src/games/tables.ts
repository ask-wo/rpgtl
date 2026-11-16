import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The columns of each table whose every change `changes` records, as runs and the player write them. */
const trackedColumns = {
  texts: [
    "inferred_translation",
    "unshortened_translation",
    "flag_reason",
    "rejected_translation",
    "rejection_reason",
    "player_translation",
  ],
  terms: [
    "inferred_translation",
    "inferred_kind",
    "inferred_pronoun",
    "player_translation",
    "player_kind",
    "player_pronoun",
  ],
} as const;

const kinds = (column: string, values: ReadonlyArray<string>) =>
  `check (${column} in (${values.map((value) => `'${value}'`).join(", ")}))`;
const termKinds = ["character", "name", "word"];
const pronouns = ["she", "he", "unknown"];

const tables = `
create table operations (
  id integer primary key,
  kind text not null ${kinds("kind", ["upgrade", "inspection", "rules", "run", "image_reading", "import", "edit", "clear", "undo"])},
  started_at text not null,
  models text
) strict;

create table settings (
  name text primary key,
  value text not null
) strict;

create table texts (
  id integer primary key,
  source text not null,
  speaker text,
  is_in_image integer not null check (is_in_image in (0, 1)),
  inferred_translation text,
  unshortened_translation text,
  flag_reason text,
  rejected_translation text,
  rejection_reason text,
  player_translation text,
  last_operation_id integer not null references operations (id)
) strict;
create unique index texts_key on texts (source, ifnull(speaker, ''), is_in_image);
create index texts_last_operation on texts (last_operation_id);

create table entries (
  id text primary key,
  text_id integer not null references texts (id),
  place text not null,
  location text not null,
  builtin_translation text,
  is_left_untranslated integer not null default 0 check (is_left_untranslated in (0, 1))
) strict;
create index entries_text on entries (text_id);
create index entries_place on entries (place);

create table terms (
  id integer primary key,
  source text not null unique,
  inferred_translation text,
  inferred_kind text not null ${kinds("inferred_kind", termKinds)},
  inferred_pronoun text ${kinds("inferred_pronoun", pronouns)},
  she_clues integer,
  he_clues integer,
  player_translation text,
  player_kind text ${kinds("player_kind", termKinds)},
  player_pronoun text ${kinds("player_pronoun", pronouns)},
  last_operation_id integer not null references operations (id)
) strict;
create index terms_last_operation on terms (last_operation_id);

create table changes (
  id integer primary key,
  operation_id integer not null references operations (id),
  table_name text not null ${kinds("table_name", Object.keys(trackedColumns))},
  row_id integer not null,
  column_name text,
  old_value any,
  new_value any
) strict;
create index changes_operation on changes (operation_id);
create index changes_value on changes (table_name, row_id, column_name);
`;

const rowJson = (table: keyof typeof trackedColumns, row: "old" | "new") =>
  `json_object(${(
    {
      texts: ["source", "speaker", "is_in_image", ...trackedColumns.texts],
      terms: ["source", ...trackedColumns.terms, "she_clues", "he_clues"],
    } satisfies Record<keyof typeof trackedColumns, ReadonlyArray<string>>
  )[table]
    .map((column) => `'${column}', ${row}.${column}`)
    .join(", ")})`;

// A trigger, unlike each write path, can't forget to record a change. A new text without any
// translation, as reading the game makes thousands of, isn't one. A delete can only name the row's
// `last_operation_id`, so deleting a row sets it to the deleting operation first.
const triggers = (["texts", "terms"] as const).flatMap((table) => {
  const columns = trackedColumns[table];
  const anyValue = columns.map((column) => `new.${column} is not null`).join(" or ");
  return [
    `create trigger ${table}_inserted after insert on ${table}
     ${table === "texts" ? `when ${anyValue}` : ""}
     begin
       insert into changes (operation_id, table_name, row_id, new_value)
       values (new.last_operation_id, '${table}', new.id, ${rowJson(table, "new")});
     end`,
    `create trigger ${table}_deleted after delete on ${table}
     begin
       insert into changes (operation_id, table_name, row_id, old_value)
       values (old.last_operation_id, '${table}', old.id, ${rowJson(table, "old")});
     end`,
    ...columns.map(
      (column) => `create trigger ${table}_${column}_changed after update of ${column} on ${table}
       when old.${column} is not new.${column}
       begin
         insert into changes (operation_id, table_name, row_id, column_name, old_value, new_value)
         values (new.last_operation_id, '${table}', new.id, '${column}', old.${column}, new.${column});
       end`,
    ),
  ];
});

/** The steps that bring a game's database to its current tables, by `<number>_<name>`. */
export const migrations = {
  "1_tables": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of [...tables.split(";").filter((s) => s.trim()), ...triggers])
      yield* sql.unsafe(statement);
  }),
};
