import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import { gameFiles } from "@rpgtl/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import * as String from "effect/String";
import * as StateFolder from "../state/StateFolder.ts";
import { migrations } from "./tables.ts";

/** Each game's database, `games/<game id>/game.db` in the state folder, open while RPGTL runs. */
export class GameDatabases extends Context.Service<
  GameDatabases,
  {
    /**
     * Runs `effect` with the game's database as its `SqlClient`, creating the database with its
     * tables when there is none.
     */
    readonly use: <A, E, R>(
      id: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>>;
    /** Closes the game's database, so its folder can be removed; the next `use` opens it again. */
    readonly close: (id: string) => Effect.Effect<void>;
  }
>()("@rpgtl/server/games/GameDatabases") {}

const make = Effect.gen(function* () {
  const folder = yield* StateFolder.StateFolder;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const reactivity = yield* Reactivity.Reactivity;

  const open = Effect.fn("GameDatabases.open")(function* (id: string) {
    const filename = path.join(folder.root, gameFiles(id).database);
    yield* fs.makeDirectory(path.dirname(filename), { recursive: true });
    const client = yield* SqliteClient.make({
      filename,
      transformQueryNames: String.camelToSnake,
      transformResultNames: String.snakeToCamel,
    }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
    // SQLite checks foreign keys only on connections that turn them on. In WAL mode, `normal`
    // skips the sync on each commit: a power cut can lose the last commits but not break the file.
    yield* client.unsafe("pragma foreign_keys = on");
    yield* client.unsafe("pragma synchronous = normal");
    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(
      Effect.provideService(SqlClient.SqlClient, client),
    );
    return client;
  }, Effect.orDie);
  const databases = yield* RcMap.make({ lookup: open, idleTimeToLive: Duration.infinity });

  const use = Effect.fn("GameDatabases.use")(function* <A, E, R>(
    id: string,
    effect: Effect.Effect<A, E, R>,
  ) {
    return yield* Effect.scoped(
      Effect.flatMap(RcMap.get(databases, id), (client) =>
        Effect.provideService(effect, SqlClient.SqlClient, client),
      ),
    );
  });
  const close = Effect.fn("GameDatabases.close")(function* (id: string) {
    yield* RcMap.invalidate(databases, id);
  });
  return GameDatabases.of({ use, close });
});

export const layer = Layer.effect(GameDatabases, make);
