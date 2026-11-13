import {
  type AuditReport,
  type Catalog,
  CheckName,
  type Correction,
  type Engine,
  type Entry,
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
import { guessedValues } from "./catalog.ts";
import { capitalisedMidSentence, capitalisedWord, translationChecks } from "./checks.ts";
import { isNameEntry, isSpeakerNameEntry } from "./nameEntries.ts";
import { gameLanguage } from "./language.ts";
import { reuseKeys, showTextSpeakers } from "./reuse.ts";
import { hasTerm } from "./termMatch.ts";
import { termKind, termTranslation, entryTranslation } from "./guesses.ts";

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

/** The values the run that started at `started` guessed, and the user's corrections of them. */
function corrections(catalog: Pick<Catalog, "entries" | "glossary">, started: string | undefined) {
  const guessed = [...guessedValues(catalog)].filter(
    ({ value }) => started !== undefined && value.guess?.run === started,
  );
  const corrected = guessed.flatMap((each): Array<typeof Correction.Type> => {
    const { guess, user } = each.value;
    if (!guess || user === undefined) return [];
    const [id, source] =
      each.of === "translation"
        ? [each.entry.id, each.entry.source]
        : [each.term.source, each.term.source];
    return [{ of: each.of, id, source, guess: guess.value, user }];
  });
  return { of: guessed.length, count: corrected.length, examples: corrected.slice(0, 50) };
}

function rejectionGroups(catalog: Pick<Catalog, "entries">, log: RunLog) {
  const all = log.requests.flatMap((request) => request.rejected);
  const last = new Map(all.map((rejection) => [rejection.id, rejection]));
  return {
    all: groupRejections(all),
    untranslated: groupRejections(
      catalog.entries.flatMap((entry) => {
        const rejection = entryTranslation(entry) ? undefined : last.get(entry.id);
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

/** Sources, with their speaker, whose translations differ, matched as repeated text is reused. */
function differing(entries: ReadonlyArray<Entry>) {
  const speakerOf = showTextSpeakers(entries);
  const keyOf = reuseKeys(entries);
  const groups = new Map<
    string,
    { source: string; speaker: string | undefined; translations: Set<string> }
  >();
  for (const entry of entries) {
    if (!entryTranslation(entry)) continue;
    const speaker = speakerOf(entry);
    const key = keyOf(entry);
    const group = groups.get(key) ?? { source: entry.source, speaker, translations: new Set() };
    groups.set(key, group);
    group.translations.add(entryTranslation(entry));
  }
  const found = [...groups.values()].filter((group) => group.translations.size > 1);
  return {
    count: found.length,
    examples: found.slice(0, 20).map(({ source, speaker, translations }) => ({
      source,
      ...(speaker !== undefined && { speaker }),
      translations: [...translations],
    })),
  };
}

/** What to look at in a game's translations, and in the run of `log` when there is one. */
export function audit(
  catalog: Pick<Catalog, "entries" | "glossary" | "game">,
  log?: RunLog,
): AuditReport {
  const translated = catalog.entries.filter((entry) => entryTranslation(entry));
  const prose = translated.filter((entry) => !isNameEntry(entry) && !isSpeakerNameEntry(entry));
  const capitalised = catalog.glossary
    .filter(
      (term) =>
        termKind(term) === "word" && termTranslation(term).split(/\s+/).some(capitalisedWord),
    )
    .map((term) => {
      const lines = prose.filter((entry) => hasTerm(entry.source, term.source));
      return {
        source: term.source,
        english: termTranslation(term),
        lines: lines.filter((entry) =>
          capitalisedMidSentence(entryTranslation(entry), termTranslation(term)),
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
    for (const { check: name, detail } of check(entry, entryTranslation(entry))) {
      const group = findings[CheckName.literals.indexOf(name)];
      if (!group) continue;
      group.count++;
      if (group.examples.length < 20)
        group.examples.push({
          id: entry.id,
          source: entry.source,
          translation: entryTranslation(entry),
          ...(detail !== undefined && { detail }),
        });
    }

  return {
    capitalised,
    differing: differing(catalog.entries),
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
