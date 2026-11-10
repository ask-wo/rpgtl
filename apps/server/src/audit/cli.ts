import {
  AuditReport,
  CheckName,
  type LogicUse,
  type MissingText,
  RejectReason,
  type RunStartLine,
  type RunTotals,
} from "@rpgtl/contracts";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Audit from "./Audit.ts";

const oneLine = (text: string) => JSON.stringify(text);

const describeStart = (start: RunStartLine | undefined) =>
  start
    ? [
        start.started,
        start.translator,
        start.kind === "build-glossary" && "glossary only",
        start.model,
        start.glossaryModel !== start.model && `glossary ${start.glossaryModel}`,
        start.translator === "ollama" && start.sampling,
        start.effort !== undefined && start.effort !== "off" && `effort ${start.effort}`,
        start.translator !== "ollama" &&
          start.glossaryEffort !== undefined &&
          `glossary effort ${start.glossaryEffort}`,
        start.commit && `commit ${start.commit}`,
      ]
        .filter(Boolean)
        .join(", ")
    : "no start line";

const correctionLabels = {
  translation: "English",
  termTranslation: "Term",
  kind: "Kind",
  pronoun: "Pronoun",
} as const;

const runLines = (run: NonNullable<AuditReport["run"]>, file: string) => {
  const { summary, corrections } = run;
  const end = summary.end;
  return [
    `Run: ${describeStart(summary.start)}`,
    `  ${file}`,
    end
      ? `  ${end.stopped ? "Stopped" : end.error ? `Ended with an error: ${end.error}` : "Finished"}: ${end.translated} translated, ${end.failed.length} failed${summary.start ? ` of ${summary.start.entries}` : ""}`
      : "  No end line: RPGTL stopped during the run, or it is still going.",
    `  ${summary.requests} requests answered ${summary.answers} entries; ${summary.asks} questions about terms and pronouns${summary.failedAsks ? `, ${summary.failedAsks} failed` : ""}`,
    ...summary.warnings.map((warning) => `  Warning: ${warning}`),
    "",
    `Guesses of the run you corrected: ${corrections.count} of ${corrections.of}`,
    ...corrections.examples.flatMap((correction) => [
      `  ${correctionLabels[correction.of]} ${correction.of === "translation" ? `${correction.id} ` : ""}${oneLine(correction.source)}`,
      `    run: ${oneLine(correction.guess)}`,
      `    you: ${oneLine(correction.user)}`,
    ]),
    "",
  ];
};

const share = (n: number, totals: RunTotals) =>
  totals.answers ? `${n} (${((100 * n) / totals.answers).toFixed(1)}%)` : String(n);

const comparisonLines = (before: RunTotals, after: RunTotals) => [
  "",
  `Compared with the run before: ${describeStart(before.start)}`,
  `  answers: ${before.answers} → ${after.answers}`,
  `  failed: ${before.failed ?? "?"} → ${after.failed ?? "?"}`,
  ...CheckName.literals.map(
    (name) =>
      `  ${name}: ${share(before.findings[name] ?? 0, before)} → ${share(after.findings[name] ?? 0, after)}`,
  ),
  ...RejectReason.literals
    .filter((reason) => before.rejected[reason] || after.rejected[reason])
    .map(
      (reason) =>
        `  rejected, ${reason}: ${before.rejected[reason] ?? 0} → ${after.rejected[reason] ?? 0}`,
    ),
];

const reportLines = (report: AuditReport, logFile: (file: string) => string) => {
  const lines = report.run ? runLines(report.run, logFile(report.run.summary.file)) : [];
  lines.push("Capitalised glossary terms in prose");
  for (const term of report.capitalised)
    lines.push(`  ${term.source} → ${term.english}: ${term.lines} of ${term.of} lines`);
  if (!report.capitalised.length) lines.push("  None.");

  lines.push("", `Sources with different translations: ${report.differing.count}`);
  for (const example of report.differing.examples) {
    lines.push(`  ${oneLine(example.source)}${example.speaker ? ` (${example.speaker})` : ""}`);
    for (const translation of example.translations) lines.push(`    ${oneLine(translation)}`);
  }

  for (const group of report.findings) {
    lines.push("", `${group.check.charAt(0).toUpperCase()}${group.check.slice(1)}: ${group.count}`);
    for (const entry of group.examples)
      lines.push(
        `  ${entry.id}${entry.detail ? ` (${entry.detail})` : ""} ${oneLine(entry.source)} → ${oneLine(entry.translation)}`,
      );
  }

  lines.push("", "Rejected entries by reason");
  if (!report.run) lines.push("  No run log for this game.");
  else
    for (const [title, groups] of [
      ["All rejections in the log", report.run.rejections.all],
      ["Entries still untranslated, by their last rejection", report.run.rejections.untranslated],
    ] as const) {
      lines.push(`  ${title}: ${groups.reduce((sum, group) => sum + group.count, 0)}`);
      for (const group of groups) {
        lines.push(`    ${group.reason}: ${group.count}`);
        for (const source of group.sources) lines.push(`      ${oneLine(source)}`);
      }
    }
  if (report.comparison)
    lines.push(...comparisonLines(report.comparison.before, report.comparison.after));
  return lines;
};

const coverageLines = (groups: ReadonlyArray<MissingText>) => [
  `Text no entry covers: ${groups.reduce((sum, group) => sum + group.count, 0)}`,
  "  Comments (codes 108, 408), file names and names only the editor shows are expected here.",
  ...groups.flatMap((group) => [
    `  ${group.where}: ${group.count}`,
    ...group.examples.map((example) => `    ${oneLine(example.slice(0, 120))}`),
  ]),
];

const logicLines = (uses: ReadonlyArray<LogicUse>) => [
  `Translated text that game logic uses: ${uses.length}`,
  ...uses.flatMap((use) => [
    `  ${use.where}: ${oneLine(use.text)} → ${oneLine(use.translation)}`,
    `    ${use.line.replace(/\s+/g, " ").slice(0, 160)}`,
  ]),
];

const encodeReport = Schema.encodeEffect(Schema.fromJsonString(AuditReport, { space: 2 }));

const flags = {
  id: Argument.String("game id").pipe(Argument.withDescription("The game's id in games.json")),
  previous: Flag.Boolean("previous").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Audit the run before the newest"),
  ),
  log: Flag.File("log").pipe(Flag.withDescription("Audit another run's log"), Flag.optional),
  compare: Flag.Boolean("compare").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Add the counts of the run before next to this run's"),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print all of it as JSON"),
  ),
  coverage: Flag.Boolean("coverage").pipe(
    Flag.withDefault(false),
    Flag.withDescription("List text in the game's data and plugin settings that no entry covers"),
  ),
  logic: Flag.Boolean("logic").pipe(
    Flag.withDefault(false),
    Flag.withDescription("List translated text that game logic also uses as a value"),
  ),
};

/** `pnpm run audit`: what to look at in a game's translations and its last run. */
export const audit = Command.make(
  "audit",
  flags,
  Effect.fn("cli.audit")(function* (input) {
    const service = yield* Audit.Audit;
    const path = yield* Path.Path;
    if (input.coverage)
      return yield* Console.log(coverageLines(yield* service.coverage(input.id)).join("\n"));
    if (input.logic)
      return yield* Console.log(logicLines(yield* service.logic(input.id)).join("\n"));
    const report = yield* service.report(input.id, {
      log: Option.match(input.log, {
        onSome: (file): Audit.LogChoice => ({ _tag: "File", file }),
        onNone: (): Audit.LogChoice => ({ _tag: input.previous ? "Previous" : "Newest" }),
      }),
      compare: input.compare,
    });
    yield* Console.log(
      input.json
        ? yield* encodeReport(report).pipe(Effect.orDie)
        : reportLines(report, (file) => path.basename(file)).join("\n"),
    );
  }),
).pipe(
  Command.withDescription("Show what to look at in a game's translations and its last run"),
  Command.validate(({ previous, log, coverage, logic, compare, json }) =>
    previous && Option.isSome(log)
      ? Effect.fail(
          new CliError.ValidationError({ message: "Give --previous or --log, not both." }),
        )
      : (coverage || logic) &&
          (previous || Option.isSome(log) || compare || json || (coverage && logic))
        ? Effect.fail(
            new CliError.ValidationError({
              message: "--coverage and --logic go alone, without other options.",
            }),
          )
        : Effect.void,
  ),
);
