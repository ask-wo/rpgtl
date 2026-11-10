import type { ComparedSetup, Comparison, Entry } from "@rpgtl/contracts";
import {
  entryTranslation,
  gameLanguage,
  runAnswers,
  runLog,
  runTotals,
  showTextSpeakers,
  translationChecks,
} from "@rpgtl/domain";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/** What the report shows of one setup's run. */
function readSetup(setup: ComparedSetup, sample: Comparison["sample"]) {
  const { glossary } = sample;
  const language = gameLanguage(sample);
  const log = runLog(setup.label, setup.lines);
  const answers = runAnswers(log);
  const check = translationChecks(glossary, language);
  const seen = new Set<string>();
  let retries = 0;
  for (const request of log.requests) {
    if (request.entryIds.some((id) => seen.has(id))) retries++;
    for (const id of request.entryIds) seen.add(id);
  }
  const outputTokens = log.requests.reduce((sum, request) => sum + (request.outputTokens ?? 0), 0);
  const costs = log.requests.flatMap((request) =>
    request.costUsd === undefined ? [] : [request.costUsd],
  );
  return {
    setup,
    log,
    answers,
    totals: runTotals(log, glossary, language),
    findings: (entry: Entry) => {
      const answer = answers.get(entry.id);
      return answer ? check(answer, answer.translation).map((finding) => finding.check) : [];
    },
    /** Why each request that asked for the entry didn't give it, with the raw answer. */
    attempts: (id: string) =>
      log.requests.flatMap((request) => {
        if (!request.entryIds.includes(id)) return [];
        const reasons = request.rejected
          .filter((rejection) => rejection.id === id)
          .map((rejection) => rejection.reason);
        return [
          `${reasons.join(", ") || request.error || "no answer"}: ${(request.content ?? "").slice(0, 300)}`,
        ];
      }),
    retries,
    tokensPerSecond: setup.ms > 0 ? outputTokens / (setup.ms / 1000) : 0,
    costUsd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : undefined,
  };
}

type ReadSetup = ReturnType<typeof readSetup>;

const summaryRow = (run: ReadSetup, entries: number) => {
  const { setup, log, totals } = run;
  const findings = Object.entries(totals.findings)
    .map(([check, count]) => `${check}: ${count}`)
    .join(", ");
  const failed = log.end?.error
    ? `<span class="bad">${escape(log.end.error)}</span>`
    : String(log.end?.failed.length ?? "–");
  return `<tr><th>${escape(setup.label)}</th><td>${failed}</td>
<td>${log.requests.length} / ${run.retries}</td>
<td>${Object.values(totals.findings).reduce((sum, count) => sum + count, 0)}${findings ? `<small>${escape(findings)}</small>` : ""}</td>
<td>${(setup.ms / 1000 / Math.max(1, entries)).toFixed(2)}</td><td>${run.tokensPerSecond.toFixed(1)}</td>
<td>${setup.vramMiB === undefined ? "–" : `${setup.vramMiB} MiB`}</td>
<td>${run.costUsd === undefined ? "–" : `$${run.costUsd.toFixed(2)}`}</td>
<td>${log.warnings.map((warning) => `<small>${escape(warning)}</small>`).join("")}</td></tr>`;
};

const cell = (run: ReadSetup, entry: Entry) => {
  const kept = entryTranslation(entry);
  if (kept) return `<td class="where">kept: ${escape(kept)}</td>`;
  const answer = run.answers.get(entry.id);
  if (!answer) {
    const why = run.attempts(entry.id).join("\n");
    return `<td class="failed">failed${why ? `<pre>${escape(why)}</pre>` : ""}</td>`;
  }
  const findings = run.findings(entry);
  return findings.length
    ? `<td class="flagged">${escape(answer.translation)}<small>${escape(findings.join(", "))}</small></td>`
    : `<td>${escape(answer.translation)}</td>`;
};

/** Where each setup sent the sample's text, when it left this computer. */
const dataNotice = ({ setup, costUsd }: ReadSetup) =>
  setup.settings.translator === "codex"
    ? `<p class="bad">${escape(setup.label)} sent the sample's text to OpenAI, off this computer. It counts against the ChatGPT plan's Codex usage limits.</p>`
    : setup.settings.translator === "claude"
      ? `<p class="bad">${escape(setup.label)} sent the sample's text to Anthropic, off this computer.${costUsd === undefined ? "" : ` At API prices that is $${costUsd.toFixed(2)}.`} On a Claude subscription it counts against the plan's usage limits.</p>`
      : "";

/** The comparison as a page: a summary of each setup's run, then the sample side by side. */
export function comparisonHtml(comparison: Comparison) {
  const { entries } = comparison.sample;
  const runs = comparison.setups.map((setup) => readSetup(setup, comparison.sample));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const speakerOf = showTextSpeakers(entries);
  const kept = entries.filter((entry) => entryTranslation(entry)).length;
  const translated = entries.length - kept;
  const tables = comparison.samples.groups
    .map((group) => {
      const rows = group.ids.flatMap((id) => {
        const entry = byId.get(id);
        return entry
          ? [
              `<tr><td class="where">${escape(`${entry.file} · ${entry.path.join("/")}`)}</td><td>${escape(speakerOf(entry) ?? "")}</td><td>${escape(entry.source)}</td>${runs.map((run) => cell(run, entry)).join("")}</tr>`,
            ]
          : [];
      });
      return `<h2>${escape(group.label)}</h2>
<div class="scroll"><table class="side"><thead><tr><th>Location</th><th>Speaker</th><th>Source</th>${runs.map((run) => `<th>${escape(run.setup.label)}</th>`).join("")}</tr></thead>
<tbody>${rows.join("\n")}</tbody></table></div>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Translator comparison: ${escape(comparison.game.title)}</title>
<style>
:root { --bg: #fff; --fg: #1d1d1f; --muted: #666; --line: #ddd; --bad: #fde2e1; --warn: #fff3c4; }
@media (prefers-color-scheme: dark) { :root { --bg: #18181a; --fg: #ececec; --muted: #999; --line: #3a3a3c; --bad: #4a2422; --warn: #4a3f16; } }
body { background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; margin: 0 auto; padding: 16px; max-width: 1800px; }
table { border-collapse: collapse; margin-bottom: 24px; }
th, td { border: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; }
.side td { min-width: 180px; max-width: 360px; white-space: pre-wrap; }
.side td.where { min-width: 0; color: var(--muted); font-size: 12px; word-break: break-all; }
.scroll { overflow-x: auto; }
.failed { background: var(--bad); }
.flagged { background: var(--warn); }
.bad { color: #c22; }
small { display: block; color: var(--muted); }
pre { white-space: pre-wrap; font-size: 12px; margin: 4px 0; }
</style></head><body>
<h1>Translator comparison: ${escape(comparison.game.title)}</h1>
<p>${translated} sample entries to translate${kept ? `, and ${kept} kept as given` : ""}, each setup run as a translation run would. Failed counts the entries a run gave up on, or says why the run stopped. Retries are requests that asked again for an entry an earlier request had. Flags are the checks <code>pnpm run audit</code> runs, such as source text left or a glossary name missing. Seconds per entry include loading the model; output speed is output tokens per second of the whole run. VRAM is the most the run took beyond what was in use before it. A failed cell shows why each request for that entry was turned down, with the start of its answer.</p>
<div class="scroll"><table><thead><tr><th>Setup</th><th>Failed</th><th>Requests / retries</th><th>Flags</th><th>s/entry</th><th>tok/s</th><th>VRAM</th><th>Cost</th><th>Warnings</th></tr></thead>
<tbody>${runs.map((run) => summaryRow(run, translated)).join("\n")}</tbody></table></div>
${runs.map(dataNotice).join("\n")}
${tables}
</body></html>
`;
}
