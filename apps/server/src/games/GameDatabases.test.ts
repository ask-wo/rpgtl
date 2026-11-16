import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { game, servicesWith } from "../testUtils/state.ts";
import * as GameDatabases from "./GameDatabases.ts";

const services = GameDatabases.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Reactivity.layer, servicesWith({}))),
  Layer.provideMerge(NodeServices.layer),
);

const changes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`select operation_id, row_id, column_name, old_value, new_value from changes order by id`;
});

it.effect("every change to a tracked value is recorded with the operation that made it", () =>
  Effect.gen(function* () {
    const databases = yield* GameDatabases.GameDatabases;
    const recorded = yield* databases.use(
      game.id,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`insert into operations (id, kind, started_at) values
          (1, 'inspection', '2026-01-01T00:00:00.000Z'), (2, 'run', '2026-01-02T00:00:00.000Z'),
          (3, 'edit', '2026-01-03T00:00:00.000Z')`;
        yield* sql`insert into texts (id, source, is_in_image, last_operation_id) values (7, '雨', 0, 1)`;
        yield* sql`update texts set model_translation = 'Rain', last_operation_id = 2 where id = 7`;
        yield* sql`update texts set model_translation = 'Rain', last_operation_id = 2 where id = 7`;
        yield* sql`update texts set user_translation = 'Rainfall', last_operation_id = 3 where id = 7`;
        yield* sql`update texts set last_operation_id = 3 where id = 7`;
        yield* sql`delete from texts where id = 7`;
        return yield* changes;
      }),
    );
    assert.deepStrictEqual(recorded, [
      {
        operationId: 2,
        rowId: 7,
        columnName: "model_translation",
        oldValue: null,
        newValue: "Rain",
      },
      {
        operationId: 3,
        rowId: 7,
        columnName: "user_translation",
        oldValue: null,
        newValue: "Rainfall",
      },
      {
        operationId: 3,
        rowId: 7,
        columnName: null,
        oldValue: JSON.stringify({
          source: "雨",
          speaker: null,
          is_in_image: 0,
          model_translation: "Rain",
          unshortened_translation: null,
          flag_reason: null,
          rejected_translation: null,
          rejection_reason: null,
          user_translation: "Rainfall",
        }),
        newValue: null,
      },
    ]);
  }).pipe(Effect.provide(services)),
);

it.effect("a game's database keeps what was written after it is closed and opened again", () =>
  Effect.gen(function* () {
    const databases = yield* GameDatabases.GameDatabases;
    const write = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`insert into settings (name, value) values ('translate', 'true')`;
    });
    const read = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql`select name, value from settings`;
    });
    yield* databases.use(game.id, write);
    yield* databases.close(game.id);
    assert.deepStrictEqual(yield* databases.use(game.id, read), [
      { name: "translate", value: "true" },
    ]);
  }).pipe(Effect.provide(services)),
);
