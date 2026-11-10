import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { RunLogLine, gameFiles } from "@rpgtl/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { game, servicesWith, StateDir } from "../testUtils/state.ts";
import * as RunLogs from "./RunLogs.ts";

const Services = RunLogs.layer.pipe(
  Layer.provideMerge(servicesWith({})),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "a run's log starts with what it used and RPGTL's commit, then keeps its lines in order",
  () =>
    Effect.gen(function* () {
      const logs = yield* RunLogs.RunLogs;
      const log = yield* logs.open(game.id, {
        started: "2026-11-03T15:10:11.188Z",
        translator: "codex",
        kind: "translate",
        model: "gpt-6-luna",
        glossaryModel: "gpt-6.1-sol",
        entries: 2,
      });
      yield* Effect.forEach(
        ["first", "second", "third"],
        (message) => log.write({ type: "warning", message }),
        { concurrency: "unbounded", discard: true },
      );
      yield* log.write({ type: "end", translated: 2, failed: [], stopped: false });

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(
        yield* StateDir,
        gameFiles(game.id).logs,
        "translation-2026-11-03T15-10-11-188Z.log",
      );
      const lines = (yield* fs.readFileString(file))
        .trim()
        .split("\n")
        .map((line) => Schema.decodeSync(Schema.fromJsonString(RunLogLine))(line));
      const [start, ...rest] = lines;
      assert.include(start, { type: "run", translator: "codex", entries: 2 });
      // This repo is a git checkout, so the line names its commit.
      assert.match(start?.type === "run" ? (start.commit ?? "") : "", /^[0-9a-f]{7,}(-dirty)?$/);
      assert.deepStrictEqual(
        rest.map((line) => (line.type === "warning" ? line.message : line.type)),
        ["first", "second", "third", "end"],
      );
    }).pipe(Effect.provide(Services)),
);

it.effect(
  "a game's run logs are listed newest first, and a line that isn't a log line names it",
  () =>
    Effect.gen(function* () {
      const logs = yield* RunLogs.RunLogs;
      const start = (started: string) =>
        logs.open(game.id, {
          started,
          translator: "ollama",
          kind: "translate",
          model: "m",
          glossaryModel: "m",
          numCtx: 4096,
          sampling: "temperature-0",
          entries: 1,
        });
      yield* start("2026-11-01T00:00:00.000Z");
      const newest = yield* start("2026-11-02T00:00:00.000Z");
      yield* newest.write({ type: "warning", message: "careful" });
      const [first, second, ...rest] = yield* logs.list(game.id);
      assert.deepStrictEqual(rest, []);
      assert.match(first ?? "", /2026-11-02T00-00-00-000Z\.log$/);
      assert.match(second ?? "", /2026-11-01T00-00-00-000Z\.log$/);
      const read = yield* logs.read(first ?? "");
      assert.deepStrictEqual(
        { started: read.start?.started, warnings: read.warnings },
        { started: "2026-11-02T00:00:00.000Z", warnings: ["careful"] },
      );

      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(second ?? "", '{"type":"run"}\n{"type":"warning"}\n', {
        flag: "a",
      });
      const error = yield* Effect.flip(logs.read(second ?? ""));
      assert.deepInclude(error, { _tag: "RunLogReadError", line: 2 });
    }).pipe(Effect.provide(Services)),
);
