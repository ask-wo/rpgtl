import {
  type ClaudeSettings,
  type ComparisonSetup,
  type TranslationSettings,
  defaultChoices,
} from "@rpgtl/contracts";
import { runLog } from "@rpgtl/domain";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ollamaFlag } from "../localModels/cli.ts";
import * as Comparisons from "./Comparisons.ts";

/** A `--model` setup that doesn't make sense, with what to change. */
class SetupRejectedError extends Schema.TaggedError<SetupRejectedError>()("SetupRejectedError", {
  problem: Schema.String,
}) {
  override get message() {
    return this.problem;
  }
}

const isClaudeModel = (model: string) => model.startsWith("claude-");
/** Codex names its models like gpt-6-luna; Ollama's names carry a tag, as in gpt-oss:20b. */
const isCodexModel = (model: string) => /^gpt-\d/.test(model) && !model.includes(":");

/**
 * A setup as `--model` gives it: a model's name, which picks the translator (a Claude or Codex
 * model, else an Ollama one), then options, each after an `@`. An Ollama model runs in
 * llama-server unless `@ollama` asks for Ollama itself.
 */
export function parseSetup(spec: string, endpoint: string): Result.Result<ComparisonSetup, string> {
  const [model = "", ...options] = spec.split("@");
  let label = spec;
  let batchSize: number | undefined;
  let experts: number | undefined;
  let effort: string | undefined;
  const switches = new Set<string>();
  for (const option of options) {
    const [key = "", value] = option.split(/=(.*)/s);
    if (key === "as" && value) label = value;
    else if (key === "effort" && value) effort = value;
    else if ((key === "batch" || key === "experts") && value !== undefined) {
      const count = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (Number.isNaN(count) || (key === "batch" && count < 1))
        return Result.fail(`@${key}= takes a whole number${key === "batch" ? " above 0" : ""}.`);
      if (key === "batch") batchSize = count;
      else experts = count;
    } else if (value === undefined && (key === "qwen" || key === "ollama" || key === "think"))
      switches.add(key);
    else
      return Result.fail(
        `Unknown option @${option}. Options are @qwen, @experts=n, @ollama, @think, @effort=level, @batch=n and @as=label.`,
      );
  }
  const ollama = switches.has("ollama");
  const local = switches.has("qwen") || ollama || experts !== undefined;
  const think = switches.has("think");
  let settings: TranslationSettings;
  if (isClaudeModel(model)) {
    if (local || think)
      return Result.fail("@qwen, @experts=, @ollama and @think go with an Ollama model.");
    settings = {
      translator: "claude",
      ...defaultChoices.claude,
      model,
      ...(effort !== undefined && { effort }),
    } satisfies ClaudeSettings;
  } else if (isCodexModel(model)) {
    if (local || think) return Result.fail("A Codex model takes only @effort=, @batch= and @as=.");
    settings = {
      translator: "codex",
      ...defaultChoices.codex,
      model,
      ...(effort !== undefined && { effort }),
    };
  } else {
    if (!model.trim()) return Result.fail("Give a model's name before its options.");
    if (effort !== undefined) return Result.fail("@effort= goes with a Claude or Codex model.");
    if (think && !ollama) return Result.fail("@think needs @ollama: llama-server doesn't think.");
    if (ollama && experts !== undefined)
      return Result.fail("@ollama runs the model in Ollama, which places its layers itself.");
    settings = {
      translator: "ollama",
      endpoint,
      ...defaultChoices.ollama,
      model,
      sampling: switches.has("qwen") ? "qwen" : "temperature-0",
      ...(think && { effort: "on" }),
      ...(!ollama && { expertLayersInRam: experts ?? 0 }),
    };
  }
  return Result.succeed({
    label,
    settings,
    ...(batchSize !== undefined && { batchSize }),
  });
}

/** What the terminal shows of a setup's run once it ended; the report has the rest. */
const endedLine = ({ setup }: Extract<Comparisons.ComparisonEvent, { readonly _tag: "Ended" }>) => {
  const end = runLog(setup.label, setup.lines).end;
  const seconds = `${Math.round(setup.ms / 1000)} s`;
  return end?.error
    ? `  ${end.error} (${seconds})`
    : `  ${end?.translated ?? 0} translated, ${end?.failed.length ?? 0} failed, ${seconds}`;
};

/**
 * `pnpm run compare`: runs translator setups on a sample of the game, each as a translation run
 * would, and writes a report showing their translations side by side.
 */
export const compare = Command.make(
  "compare",
  {
    game: Flag.String("game").pipe(Flag.withDescription("The game's id in games.json")),
    model: Flag.String("model").pipe(
      Flag.atLeast(1),
      Flag.withDescription(
        "A setup to run: a model's name, then options such as @qwen, @experts=24, @ollama, @think, @effort=low, @batch=5 or @as=label. Repeat it for more.",
      ),
    ),
    ollama: ollamaFlag,
  },
  Effect.fn("cli.compare")(function* ({ game, model, ollama }) {
    const comparisons = yield* Comparisons.Comparisons;
    const setups = yield* Effect.forEach(model, (spec) =>
      Effect.fromResult(parseSetup(spec, ollama.href)).pipe(
        Effect.mapError((problem) => new SetupRejectedError({ problem })),
      ),
    );
    const report = yield* Ref.make(Option.none<string>());
    yield* Stream.runForEach(
      yield* comparisons.compare(game, setups),
      Comparisons.ComparisonEvent.$match({
        Started: ({ label, entries }) => Console.log(`${label}: ${entries} sample entries…`),
        Ended: (ended) =>
          Console.log(endedLine(ended)).pipe(
            Effect.andThen(Ref.set(report, Option.some(ended.report))),
          ),
      }),
    );
    const file = yield* Ref.get(report);
    if (Option.isSome(file)) yield* Console.log(`Report: ${file.value}`);
  }),
).pipe(
  Command.withDescription(
    "Run translator setups on a sample of a game and show their translations side by side",
  ),
);
