import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as CodexLanguageModel from "./CodexLanguageModel.ts";

/** The Codex CLI ended with an exit code other than 0, after saying why itself. */
class CodexExitedError extends Schema.TaggedError<CodexExitedError>()("CodexExitedError", {
  code: Schema.Int,
}) {
  override get message() {
    return `Codex exited with code ${this.code}.`;
  }
}

/** Runs the installed Codex CLI on RPGTL's Codex home in this terminal. */
const runCodex = Effect.fn("cli.runCodex")(function* (args: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cli = yield* CodexLanguageModel.codexCli;
  yield* fs.makeDirectory(cli.home, { recursive: true });
  const code = yield* spawner.exitCode(
    cli.command(args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
  );
  if (code !== 0) return yield* new CodexExitedError({ code });
});

const login = Command.make(
  "login",
  {
    deviceAuth: Flag.Boolean("device-auth").pipe(
      Flag.withDescription("Log in with a code instead of a browser on this computer"),
      Flag.withDefault(false),
    ),
  },
  ({ deviceAuth }) => runCodex(["login", ...(deviceAuth ? ["--device-auth"] : [])]),
).pipe(
  Command.withDescription("Log RPGTL's Codex home in to your ChatGPT plan"),
  Command.withSubcommands([
    Command.make("status", {}, () => runCodex(["login", "status"])).pipe(
      Command.withDescription("Show whether RPGTL's Codex home is logged in"),
    ),
  ]),
);

/** `pnpm run codex`: RPGTL's own Codex login, apart from the Codex app's. */
export const codex = Command.make("codex").pipe(
  Command.withDescription("Manage the ChatGPT login RPGTL's Codex translator uses"),
  Command.withSubcommands([
    login,
    Command.make("logout", {}, () => runCodex(["logout"])).pipe(
      Command.withDescription("Log RPGTL's Codex home out"),
    ),
  ]),
);
