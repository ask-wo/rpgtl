import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Audit from "./audit/Audit.ts";
import * as AuditCli from "./audit/cli.ts";
import * as ComparisonCli from "./comparison/cli.ts";
import * as Comparisons from "./comparison/Comparisons.ts";
import * as Catalogs from "./games/Catalogs.ts";
import * as GameFolder from "./games/GameFolder.ts";
import * as Games from "./games/Games.ts";
import * as FreeMemory from "./localModels/FreeMemory.ts";
import * as LlamaServer from "./localModels/LlamaServer.ts";
import * as LocalModelsCli from "./localModels/cli.ts";
import * as TranslationCli from "./translation/cli.ts";
import * as Ollama from "./localModels/Ollama.ts";
import * as ImageTexts from "./imageText/ImageTexts.ts";
import * as StateFolder from "./state/StateFolder.ts";
import * as AgentModels from "./translation/AgentModels.ts";
import * as RunLogs from "./translation/RunLogs.ts";

/** The services the commands use, over the state folder `state` or `RPGTL_DIR`'s. */
const services = (state: Option.Option<string>) =>
  Layer.mergeAll(Audit.layer, Comparisons.layer).pipe(
    Layer.provideMerge(LlamaServer.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Catalogs.layer,
        RunLogs.layer,
        Ollama.layer,
        AgentModels.layer,
        FreeMemory.layer,
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(Games.layer, GameFolder.layer, ImageTexts.layer)),
    Layer.provideMerge(
      Option.match(state, { onNone: () => StateFolder.layer, onSome: StateFolder.layerAt }),
    ),
    // As for the server, the endpoints are on this computer, so redirects aren't followed.
    Layer.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
      ),
    ),
  );

const rpgtl = Command.make("rpgtl").pipe(
  Command.withSharedFlags({
    state: Flag.Directory("state").pipe(
      Flag.withDescription("RPGTL's state folder; RPGTL_DIR, or .rpgtl/, when not given"),
      Flag.optional,
    ),
  }),
  Command.withDescription("RPGTL's command-line tools"),
  Command.withSubcommands([
    AuditCli.audit,
    ComparisonCli.compare,
    TranslationCli.codex,
    LocalModelsCli.llamaServer,
  ]),
  Command.provide(({ state }) => services(state)),
);

/** A command's failure, which the command already printed. */
class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {}) {
  override readonly [Runtime.errorReported] = false;
}

Command.run(rpgtl, { version: "0.1.0" }).pipe(
  // Each service error's message is written for the person who started the command; its cause is
  // for debugging, so it goes to the debug log.
  Effect.catchIf(
    (error) => !CliError.isCliError(error),
    (error) =>
      Effect.logDebug(error).pipe(
        Effect.andThen(Console.error(error.message)),
        Effect.andThen(Effect.fail(new CommandFailed())),
      ),
  ),
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- the command-line tools' entry point
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
