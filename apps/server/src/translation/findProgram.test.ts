import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { OnWindows } from "../OnWindows.ts";
import { ChildEnvironment } from "./ChildEnvironment.ts";
import { findProgram } from "./findProgram.ts";

const dp0 = '"%dp0%\\';

/** A shim as npm writes it on Windows, ending with `lines`. */
const shim = (...lines: ReadonlyArray<string>) =>
  [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    ...lines,
    "",
  ].join("\r\n");

it.layer(NodeServices.layer)((test) => {
  test.effect("finds a program in the first PATH folder that has it, or a path as given", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      for (const folder of ["empty", "first", "second"])
        yield* fs.makeDirectory(path.join(dir, folder));
      yield* fs.writeFileString(path.join(dir, "first", "codex"), "");
      yield* fs.writeFileString(path.join(dir, "second", "codex"), "");
      yield* fs.makeDirectory(path.join(dir, "second", "claude"));
      const PATH = ["empty", "first", "second"].map((folder) => path.join(dir, folder)).join(":");
      const find = (name: string) =>
        findProgram(name).pipe(Effect.provideService(ChildEnvironment, { PATH }));
      assert.deepStrictEqual(yield* find("codex"), Option.some(path.join(dir, "first", "codex")));
      assert.deepStrictEqual(yield* find("claude"), Option.none());
      assert.deepStrictEqual(
        yield* find(path.join(dir, "second", "codex")),
        Option.some(path.join(dir, "second", "codex")),
      );
      assert.deepStrictEqual(yield* find(path.join(dir, "missing")), Option.none());
    }),
  );

  test.effect("on Windows, finds the Node script or program behind npm's .cmd shim", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const script = String.raw`node_modules\@openai\codex\bin\codex.js`;
      yield* fs.writeFileString(
        path.join(dir, "codex.cmd"),
        shim(
          "",
          String.raw`IF EXIST "%dp0%\node.exe" (`,
          String.raw`  SET "_prog=%dp0%\node.exe"`,
          ") ELSE (",
          '  SET "_prog=node"',
          ")",
          "",
          `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  ${dp0}${script}" %*`,
        ),
      );
      const native = String.raw`node_modules\@anthropic-ai\claude-code\bin\claude.exe`;
      yield* fs.writeFileString(path.join(dir, "claude.cmd"), shim(`${dp0}${native}"   %*`));
      yield* fs.writeFileString(path.join(dir, "gone.cmd"), shim(`${dp0}missing.exe"   %*`));
      for (const target of [script, native]) {
        const file = path.join(dir, ...target.split("\\"));
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const find = (name: string) =>
        findProgram(name).pipe(
          Effect.provideService(ChildEnvironment, { PATH: `${dir};`, PATHEXT: ".exe;.cmd" }),
          Effect.provideService(OnWindows, true),
        );
      assert.deepStrictEqual(
        yield* find("codex"),
        Option.some(path.join(dir, "node_modules/@openai/codex/bin/codex.js")),
      );
      assert.deepStrictEqual(
        yield* find("claude"),
        Option.some(path.join(dir, "node_modules/@anthropic-ai/claude-code/bin/claude.exe")),
      );
      assert.deepStrictEqual(yield* find("gone"), Option.none());
    }),
  );
});
