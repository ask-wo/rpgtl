import {
  type AuditReport,
  type Catalog,
  CheckName,
  type Correction,
  type Engine,
  type GlossaryTerm,
  type RejectionGroup,
  type RejectReason,
  type RequestLine,
  type RunEndLine,
  type RunLogLine,
  type RunStartLine,
  type SourceLanguage,
  type RunSummary,
  type RunTotals,
} from "@rpgtl/contracts";
import { entryTexts } from "./catalog.ts";
import {
  capitalisedMidSentence,
  capitalisedWord,
  glossaryFindings,
  translationChecks,
} from "./checks.ts";
import { isNameEntry, isSpeakerNameEntry } from "./nameEntries.ts";
import { gameLanguage } from "./language.ts";
import { hasTerm } from "./termMatch.ts";
import { termKind, translationInUse } from "./inUse.ts";

/** A run's log, its lines sorted by kind. */
export interface RunLog {
  readonly file: string;
  readonly start: RunStartLine | undefined;
  readonly requests: ReadonlyArray<RequestLine>;
  readonly asks: number;
  readonly failedAsks: number;
  readonly warnings: ReadonlyArray<string>;
  /** None when RPGTL stopped during the run, or it still goes on. */
  readonly end: RunEndLine | undefined;
}

export const runLog = (file: string, lines: ReadonlyArray<RunLogLine>): RunLog => ({
  file,
  start: lines.find((line) => line.type === "run"),
  requests: lines.filter((line) => line.type === "request"),
  asks: lines.filter((line) => line.type === "ask").length,
  failedAsks: lines.filter((line) => line.type === "ask" && line.error !== undefined).length,
  warnings: lines.flatMap((line) => (line.type === "warning" ? [line.message] : [])),
  end: lines.findLast((line) => line.type === "end"),
});

/** The translations a run's answers gave, by entry id; a later answer wins. */
export function runAnswers(log: Pick<RunLog, "requests">) {
  const answers = new Map<string, RequestLine["entries"][number]>();
  for (const request of log.requests)
    for (const entry of request.entries) if (entry.translation) answers.set(entry.id, entry);
  return answers;
}

function groupRejections(
  rejections: ReadonlyArray<{ readonly source: string; readonly reason: RejectReason }>,
) {
  const groups = new Map<RejectReason, { count: number; sources: Set<string> }>();
  for (const { source, reason } of rejections) {
    const group = groups.get(reason) ?? { count: 0, sources: new Set<string>() };
    groups.set(reason, group);
    group.count++;
    if (group.sources.size < 10) group.sources.add(source);
  }
  return [...groups]
    .map(([reason, { count, sources }]): RejectionGroup => ({
      reason,
      count,
      sources: [...sources],
    }))
    .toSorted((a, b) => b.count - a.count);
}

const summary = (log: RunLog): RunSummary => ({
  file: log.file,
  ...(log.start && { start: log.start }),
  ...(log.end && { end: log.end }),
  warnings: log.warnings,
  requests: log.requests.length,
  asks: log.asks,
  failedAsks: log.failedAsks,
  answers: runAnswers(log).size,
});

/**
 * The translations the model gave in the run that started at `started` and are still its, and the
 * user's corrections of them.
 */
function corrections(
  catalog: Pick<Catalog, "entries" | "texts" | "glossary" | "operations">,
  started: string | undefined,
) {
  const run = catalog.operations.find(
    (operation) => operation.kind === "run" && operation.startedAt === started,
  );
  const fromRun = <T extends Pick<GlossaryTerm, "modelOperationId">>(values: ReadonlyArray<T>) =>
    run === undefined ? [] : values.filter((value) => value.modelOperationId === run.id);
  const firstEntry = new Map<number, string>();
  for (const entry of catalog.entries)
    if (!firstEntry.has(entry.textId)) firstEntry.set(entry.textId, entry.id);
  const texts = fromRun(catalog.texts);
  const terms = fromRun(catalog.glossary);
  const corrected: Array<typeof Correction.Type> = [
    ...texts.flatMap(({ id, source, modelTranslation, userTranslation }) =>
      modelTranslation === undefined || userTranslation === undefined
        ? []
        : [
            {
              of: "translation" as const,
              id: firstEntry.get(id) ?? String(id),
              source,
              modelTranslation,
              user: userTranslation,
            },
          ],
    ),
    ...terms.flatMap(({ source, modelTranslation, userTranslation }) =>
      modelTranslation === undefined || userTranslation === undefined
        ? []
        : [
            {
              of: "termTranslation" as const,
              id: source,
              source,
              modelTranslation,
              user: userTranslation,
            },
          ],
    ),
  ];
  return {
    of: texts.length + terms.length,
    count: corrected.length,
    examples: corrected.slice(0, 50),
  };
}

function rejectionGroups(catalog: Pick<Catalog, "entries" | "texts">, log: RunLog) {
  const all = log.requests.flatMap((request) => request.rejected);
  const last = new Map(all.map((rejection) => [rejection.id, rejection]));
  return {
    all: groupRejections(all),
    untranslated: groupRejections(
      entryTexts(catalog).flatMap((entry) => {
        const rejection = translationInUse(entry) ? undefined : last.get(entry.id);
        return rejection ? [rejection] : [];
      }),
    ),
  };
}

export function runTotals(
  log: RunLog,
  glossary: Catalog["glossary"],
  language: SourceLanguage,
  engine: Engine,
): RunTotals {
  const check = translationChecks(glossary, language, engine);
  const answers = runAnswers(log);
  const findings: Partial<Record<CheckName, number>> = {};
  for (const entry of answers.values())
    for (const finding of check(entry, entry.translation))
      findings[finding.check] = (findings[finding.check] ?? 0) + 1;
  const rejected: Partial<Record<RejectReason, number>> = {};
  for (const { reason } of log.requests.flatMap((request) => request.rejected))
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  return {
    file: log.file,
    ...(log.start && { start: log.start }),
    answers: answers.size,
    ...(log.end && { failed: log.end.failed.length }),
    rejected,
    findings,
  };
}

/** What to look at in a game's translations, and in the run of `log` when there is one. */
export function audit(
  catalog: Pick<Catalog, "entries" | "texts" | "glossary" | "game" | "settings" | "operations">,
  log?: RunLog,
): AuditReport {
  const translated = entryTexts(catalog).filter((entry) => translationInUse(entry));
  const prose = translated.filter((entry) => !isNameEntry(entry) && !isSpeakerNameEntry(entry));
  const capitalised = catalog.glossary
    .filter(
      (term) =>
        termKind(term) === "word" && translationInUse(term).split(/\s+/).some(capitalisedWord),
    )
    .map((term) => {
      const lines = prose.filter((entry) => hasTerm(entry.source, term.source));
      return {
        source: term.source,
        english: translationInUse(term),
        lines: lines.filter((entry) =>
          capitalisedMidSentence(translationInUse(entry), translationInUse(term)),
        ).length,
        of: lines.length,
      };
    })
    .filter((term) => term.lines > 0)
    .toSorted((a, b) => b.lines - a.lines);

  const check = translationChecks(catalog.glossary, gameLanguage(catalog), catalog.game.engine);
  const findings = CheckName.literals.map((name) => ({
    check: name,
    count: 0,
    examples: new Array<AuditReport["findings"][number]["examples"][number]>(),
  }));
  for (const entry of translated)
    for (const { check: name, detail } of check(entry, translationInUse(entry))) {
      const group = findings[CheckName.literals.indexOf(name)];
      if (!group) continue;
      group.count++;
      if (group.examples.length < 20)
        group.examples.push({
          id: entry.id,
          source: entry.source,
          translation: translationInUse(entry),
          ...(detail !== undefined && { detail }),
        });
    }

  const inGlossary = glossaryFindings(catalog.glossary);
  return {
    capitalised,
    terms: catalog.glossary.flatMap((term) => {
      const missing = inGlossary.get(term.source);
      return missing ? [{ source: term.source, english: translationInUse(term), missing }] : [];
    }),
    findings,
    ...(log && {
      run: {
        summary: summary(log),
        corrections: corrections(catalog, log.start?.started),
        rejections: rejectionGroups(catalog, log),
      },
    }),
  };
}
