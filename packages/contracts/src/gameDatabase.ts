import * as String from "effect/String";
import type { GlossaryTerm, Text } from "./catalog.ts";

/** The columns of `texts` that runs and the user write; `changes` records each of their changes. */
export const textColumns = [
  "modelTranslation",
  "unshortenedTranslation",
  "flagReason",
  "rejectedTranslation",
  "rejectionReason",
  "userTranslation",
] as const satisfies ReadonlyArray<keyof Text>;

/** The columns of `glossary` that runs and the user write. */
export const termColumns = [
  "source",
  "modelTranslation",
  "userTranslation",
  "rulesKind",
  "modelKind",
  "userKind",
  "rulesPronoun",
  "sheClues",
  "heClues",
  "modelPronoun",
  "userPronoun",
] as const satisfies ReadonlyArray<keyof GlossaryTerm>;

/** The columns of `glossary` whose changes `changes` doesn't record. */
const untrackedTermColumns: ReadonlySet<string> = new Set(["source", "sheClues", "heClues"]);

const trackedColumns = {
  texts: textColumns.map(String.camelToSnake),
  glossary: termColumns
    .filter((column) => !untrackedTermColumns.has(column))
    .map(String.camelToSnake),
};

const kinds = (column: string, values: ReadonlyArray<string>) =>
  `check (${column} in (${values.map((value) => `'${value}'`).join(", ")}))`;
const termKinds = ["character", "name", "word"];
const pronouns = ["she", "he", "unknown"];

const tables = `
create table operations (
  id integer primary key,
  kind text not null ${kinds("kind", ["upgrade", "inspection", "run", "image_reading", "import", "edit", "clear", "undo"])},
  started_at text not null,
  models text
) strict;

create table settings (
  name text primary key,
  value text not null
) strict;

create table texts (
  id integer primary key autoincrement,
  source text not null,
  speaker text,
  is_in_image integer not null check (is_in_image in (0, 1)),
  model_translation text,
  unshortened_translation text,
  flag_reason text,
  rejected_translation text,
  rejection_reason text,
  user_translation text,
  last_operation_id integer not null references operations (id)
) strict;
create unique index texts_key on texts (source, ifnull(speaker, ''), is_in_image);
create index texts_last_operation on texts (last_operation_id);

create table entries (
  id text primary key,
  text_id integer not null references texts (id),
  position integer not null,
  place text not null,
  location text not null,
  builtin_translation text,
  is_left_untranslated integer not null default 0 check (is_left_untranslated in (0, 1))
) strict;
create index entries_text on entries (text_id);
create index entries_place on entries (place);

create table glossary (
  id integer primary key autoincrement,
  source text not null unique,
  model_translation text,
  user_translation text,
  rules_kind text not null ${kinds("rules_kind", termKinds)},
  model_kind text ${kinds("model_kind", termKinds)},
  user_kind text ${kinds("user_kind", termKinds)},
  rules_pronoun text ${kinds("rules_pronoun", pronouns)},
  she_clues integer,
  he_clues integer,
  model_pronoun text ${kinds("model_pronoun", pronouns)},
  user_pronoun text ${kinds("user_pronoun", pronouns)},
  last_operation_id integer not null references operations (id)
) strict;
create index glossary_last_operation on glossary (last_operation_id);

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
      glossary: ["source", ...trackedColumns.glossary, "she_clues", "he_clues"],
    } satisfies Record<keyof typeof trackedColumns, ReadonlyArray<string>>
  )[table]
    .map((column) => `'${column}', ${row}.${column}`)
    .join(", ")})`;

// A trigger, unlike each write path, can't forget to record a change. A new text without any
// translation, as reading the game makes thousands of, isn't one. A delete can only name the row's
// `last_operation_id`, so deleting a row sets it to the deleting operation first.
const triggers = (["texts", "glossary"] as const).flatMap((table) => {
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

/**
 * The SQL statements that bring a game's database, `games/<game id>/game.db` in the state folder,
 * to its current tables, by migration name `<number>_<name>`. The server writes the database and
 * the NW.js hook reads it.
 */
export const gameDatabaseMigrations: Readonly<Record<string, ReadonlyArray<string>>> = {
  "1_tables": [...tables.split(";").filter((statement) => statement.trim()), ...triggers],
};
