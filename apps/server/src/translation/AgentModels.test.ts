import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as AgentModels from "./AgentModels.ts";
import { ChildEnvironment } from "./ChildEnvironment.ts";
import { ClaudeProgram } from "./ClaudeLanguageModel.ts";
import { CodexCommand } from "./CodexLanguageModel.ts";

const claudeList: ReadonlyArray<ModelInfo> = [
  {
    value: "default",
    resolvedModel: "claude-opus-9",
    displayName: "Default (recommended)",
    description: "Use the default model (currently Opus 9)",
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-9",
    displayName: "Opus",
    description: "Opus 9 · Best for everyday tasks",
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    value: "claude-epic-8[1m]",
    resolvedModel: "claude-epic-8",
    displayName: "Epic",
    description: "Epic 8 · Most capable",
    supportedEffortLevels: ["low", "max"],
  },
];

/** The service over a new user state folder, with the fake `codex` and `models` as Claude's list. */
const services = (environment: Record<string, string> = {}, models = claudeList) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      return AgentModels.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CodexCommand, {
              command: process.execPath,
              args: [path.join(import.meta.dirname, "../testUtils/fakeCodex.ts")],
            }),
            Layer.succeed(ClaudeProgram, process.execPath),
            Layer.succeed(AgentModels.ClaudeModelList, () => Effect.succeed(models)),
            Layer.succeed(ChildEnvironment, { PATH: "/usr/bin", ...environment }),
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ XDG_STATE_HOME: dir, HOME: "/nowhere" }),
            ),
          ),
        ),
      );
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("lists Claude's models once each, by version, with their effort levels", () =>
  Effect.gen(function* () {
    const agentModels = yield* AgentModels.AgentModels;
    assert.deepStrictEqual(yield* agentModels.claude, [
      { id: "claude-opus-9", name: "Opus 9", efforts: ["low", "medium", "high"], isDefault: true },
      { id: "claude-epic-8", name: "Epic 8", efforts: ["low", "max"], isDefault: false },
    ]);
  }).pipe(Effect.provide(services())),
);

const unversionedList: ReadonlyArray<ModelInfo> = [
  {
    value: "opus",
    resolvedModel: "claude-opus-9-1",
    displayName: "Opus",
    description: "Best for everyday tasks",
  },
  { value: "claude-opus-9", displayName: "Opus", description: "Best for everyday tasks" },
  { value: "claude-3-5-epic-20250101", displayName: "Epic", description: "Fast" },
];

it.effect("names Claude's models by their id when the descriptions don't name the version", () =>
  Effect.gen(function* () {
    const agentModels = yield* AgentModels.AgentModels;
    assert.deepStrictEqual(
      (yield* agentModels.claude).map((model) => model.name),
      ["Opus 9.1", "Opus 9", "Epic 3.5"],
    );
  }).pipe(Effect.provide(services({}, unversionedList))),
);

it.effect("lists the models Codex offers the login's plan, without hidden ones", () =>
  Effect.gen(function* () {
    const agentModels = yield* AgentModels.AgentModels;
    assert.deepStrictEqual(yield* agentModels.codex, [
      {
        id: "gpt-9-plan",
        name: "GPT-9-PLAN",
        efforts: ["low", "medium", "ultra"],
        defaultEffort: "low",
        isDefault: true,
      },
    ]);
  }).pipe(Effect.provide(services())),
);

it.effect("says when Codex isn't logged in", () =>
  Effect.gen(function* () {
    const agentModels = yield* AgentModels.AgentModels;
    const error = yield* Effect.flip(agentModels.codex);
    assert.include(error.message, "not logged in");
  }).pipe(Effect.provide(services({ FAKE_CODEX_LOGGED_OUT: "1" }))),
);
