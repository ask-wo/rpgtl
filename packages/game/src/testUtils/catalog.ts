import { mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gameDatabaseMigrations, type GameSettings } from "@rpgtl/contracts";
import {
  decodeGameFile,
  decodePlugins,
  type EntryText,
  fileOf,
  gameEntries,
  inspectedEntries,
  type ReadEntry,
} from "@rpgtl/domain";
import { Result } from "effect";

const readOr = (file: string, fallback: string) => readFile(file, "utf8").catch(() => fallback);

/** The entries of the game at `webRoot`, as reading it gives them. */
export async function fixtureEntries(webRoot: string): Promise<ReadEntry[]> {
  const plugins = Result.getOrThrow(
    decodePlugins(await readOr(path.join(webRoot, "js", "plugins.js"), "[]")),
  );
  const pluginCode = new Map<string, string>();
  for (const plugin of plugins)
    if (plugin)
      pluginCode.set(
        plugin.name,
        await readOr(path.join(webRoot, "js", "plugins", `${plugin.name}.js`), ""),
      );
  const assets = [];
  for (const folder of ["img", "audio", "movies"])
    for (const file of await readdir(path.join(webRoot, folder), {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []))
      if (file.isFile())
        assets.push(
          path.relative(webRoot, path.join(file.parentPath, file.name)).split(path.sep).join("/"),
        );
  const dataFiles = [];
  for (const name of (await readdir(path.join(webRoot, "data"))).toSorted()) {
    if (!name.endsWith(".json")) continue;
    const text = await readFile(path.join(webRoot, "data", name), "utf8");
    dataFiles.push({ name, data: Result.getOrThrow(decodeGameFile(name, text)) });
  }
  return gameEntries({ plugins, pluginCode, assets, dataFiles });
}

type Row = Record<string, string | number | null>;

/**
 * A game's database at `file` with the tables the server makes, for tests of what reads it. A new
 * one holds no entries and has the translation switch on.
 */
export class FixtureDatabase {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    mkdirSync(path.dirname(file), { recursive: true });
    this.#with((database) => {
      for (const statements of Object.values(gameDatabaseMigrations))
        for (const statement of statements) database.exec(statement);
      database
        .prepare("insert into operations (kind, started_at) values ('inspection', ?)")
        .run(new Date().toISOString());
    });
    this.set("isTranslationOn", true);
  }

  #with<A>(f: (database: DatabaseSync) => A): A {
    const database = new DatabaseSync(this.file);
    try {
      return f(database);
    } finally {
      database.close();
    }
  }

  /** Adds the entries after those it holds, each with the text of its source, speaker and image flag. */
  add(read: ReadonlyArray<ReadEntry>) {
    this.#with((database) => {
      const [{ count = 0 } = {}] = database
        .prepare("select count(*) as count from entries")
        .all() as Array<{ count?: number }>;
      for (const [index, entry] of inspectedEntries(read, undefined).entries()) {
        const key = [entry.source, entry.speaker ?? "", entry.isInImage ? 1 : 0] as const;
        database
          .prepare(
            `insert into texts (source, speaker, is_in_image, last_operation_id) values (?, ?, ?, 1)
             on conflict (source, ifnull(speaker, ''), is_in_image) do nothing`,
          )
          .run(entry.source, entry.speaker ?? null, key[2]);
        const [text] = database
          .prepare(
            "select id from texts where source = ? and ifnull(speaker, '') = ? and is_in_image = ?",
          )
          .all(...key) as Array<{ id: number }>;
        database
          .prepare(
            `insert into entries (id, text_id, position, place, location, builtin_translation)
             values (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            entry.id,
            text?.id ?? 0,
            count + index,
            fileOf(entry.location),
            JSON.stringify(entry.location),
            entry.builtinTranslation ?? null,
          );
      }
    });
  }

  /** Each entry with the source, speaker, image flag and English of its text. */
  entries(): EntryText[] {
    return this.#with((database) =>
      (
        database
          .prepare(
            `select e.id, e.text_id, e.location, t.source, t.speaker, t.is_in_image,
               t.user_translation
             from entries e join texts t on t.id = e.text_id order by e.position`,
          )
          .all() as Row[]
      ).map((row) => ({
        id: String(row.id),
        textId: Number(row.text_id),
        location: JSON.parse(String(row.location)),
        source: String(row.source),
        isInImage: row.is_in_image === 1,
        ...(row.speaker !== null && { speaker: String(row.speaker) }),
        ...(row.user_translation !== null && { userTranslation: String(row.user_translation) }),
      })),
    );
  }

  /** Gives the text of each entry that `english` names the user's English. */
  translate(english: (entry: EntryText) => string | undefined) {
    const typed = this.entries().flatMap((entry) => {
      const translation = english(entry);
      return translation === undefined ? [] : [[translation, entry.textId] as const];
    });
    this.#with((database) => {
      for (const [translation, id] of typed)
        database.prepare("update texts set user_translation = ? where id = ?").run(translation, id);
    });
  }

  /** Saves the setting, as the server encodes it. */
  set<K extends keyof GameSettings>(name: K, value: GameSettings[K]) {
    this.#with((database) =>
      database
        .prepare(
          `insert into settings (name, value) values (?, ?)
           on conflict (name) do update set value = excluded.value`,
        )
        .run(name, JSON.stringify(value)),
    );
  }
}
