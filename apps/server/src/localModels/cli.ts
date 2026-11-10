import { endpointProblem } from "@rpgtl/contracts";
import { localEndpoint } from "@rpgtl/domain";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as StateFolder from "../state/StateFolder.ts";
import * as LlamaServer from "./LlamaServer.ts";

/** `--ollama`: the Ollama endpoint, which must be on this computer, as a run's must. */
export const ollamaFlag = Flag.String("ollama").pipe(
  Flag.withDescription("The Ollama endpoint, on this computer"),
  Flag.withDefault("http://127.0.0.1:11434"),
  Flag.mapEffect((text) =>
    Effect.fromResult(localEndpoint(text)).pipe(
      Effect.mapError(
        (problem) => new CliError.ValidationError({ message: endpointProblem(problem) }),
      ),
    ),
  ),
);

/**
 * `pnpm run llama-server`: Ollama's bundled llama-server for one of its models, with 4 slots as
 * a run uses, until Ctrl+C or SIGTERM stops it.
 */
export const llamaServer = Command.make(
  "llama-server",
  {
    model: Flag.String("model").pipe(Flag.withDescription("An Ollama model")),
    experts: Flag.Int("experts").pipe(
      Flag.withDescription("Expert layers in system RAM"),
      Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    ),
    ctx: Flag.Int("ctx").pipe(
      Flag.withDescription("Tokens of context per slot"),
      Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      Flag.withDefault(4096),
    ),
    ollama: ollamaFlag,
  },
  Effect.fn("cli.llamaServer")(function* (input) {
    const folder = yield* StateFolder.StateFolder;
    const server = yield* (yield* LlamaServer.LlamaServer).serve({
      endpoint: input.ollama,
      model: input.model,
      unload: [input.model],
      expertLayersInRam: input.experts,
      slots: 4,
      numCtx: input.ctx,
      log: `${folder.root}/logs/manual-llama-server.log`,
    });
    yield* Console.log(server.api.origin);
    // `ended` waits a moment for the process to end; Ctrl+C or SIGTERM interrupts the wait and
    // closes the scope, which stops the server.
    const ended = yield* server.ended.pipe(Effect.repeat({ until: Option.isSome }));
    if (Option.isSome(ended)) return yield* ended.value;
  }, Effect.scoped),
).pipe(
  Command.withDescription(
    "Start Ollama's llama-server for a model with some expert layers in system RAM",
  ),
);
