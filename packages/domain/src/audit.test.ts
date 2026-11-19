import { assert, it } from "@effect/vitest";
import type { RejectReason, RunLogLine } from "@rpgtl/contracts";
import { audit, runAnswers, runLog, runTotals, withTexts } from "./index.ts";
import { testCatalog, testTerm } from "./testUtils/catalog.ts";

const line = (index: number, source: string, translation: string) => ({
  id: `entry${index}`,
  location: {
    _tag: "Message" as const,
    list: { _tag: "MapEventPage" as const, map: 1, event: 1, page: 0 },
    index: index,
  },
  source,
  ...(translation && { userTranslation: translation }),
});
const started = "2026-10-01T00:00:00.000Z";
const request = (
  entries: ReadonlyArray<ReturnType<typeof line>>,
  rejected: ReadonlyArray<RejectReason> = [],
  answer?: string,
): RunLogLine => ({
  type: "request",
  at: started,
  entryIds: entries.map((entry) => entry.id),
  entries: entries.map(({ id, location, source, userTranslation }) => ({
    id,
    location,
    source,
    translation: answer ?? userTranslation ?? "",
  })),
  answerContexts: entries.map(() => ({})),
  request: { model: "test-model", messages: [] },
  ms: 1,
  rejected: rejected.map((reason) => ({
    id: entries[0]?.id ?? "",
    source: entries[0]?.source ?? "",
    codes: ["\\C[0]"],
    reason,
  })),
});

const red = line(10, "\\C[2]红\\C[0]", "");
const catalog = testCatalog({
  glossary: [
    testTerm("身体", { userTranslation: "Body" }),
    testTerm("林若溪", { userTranslation: "Lin Ruoxi", rulesKind: "character" }),
  ],
  entries: [
    line(0, "她的身体很冷", "Her Body is cold"),
    line(2, "身体好", "Body is fine"),
    line(4, "进入仓库", "Enter the storehouse"),
    line(6, "进入仓库", "Entering the storehouse"),
    line(8, "坏的预感。", "the bad预感"),
    red,
    line(12, "她看见林若溪", "She saw Lin Ruoxi"),
    line(14, "\\n<星澜>好热", '\\n<Xinglan>Xinglan: "So hot"'),
    line(15, "我很兴奋。", "I'm excited.\n\n3"),
    line(16, "林若溪笑了。", "Xinglan smiled."),
    line(18, "她笑了。", "He smiled."),
    line(
      20,
      "嗯哼？",
      "Right, once we sneak into the prison later, the demon king will surely sense it.",
    ),
    line(22, "画师:青木流水", "Artist: 青木流水"),
  ],
});

it("The audit lists capitalised glossary words and each check's finds", () => {
  const result = audit(catalog);
  assert.deepStrictEqual(result.capitalised, [
    { source: "身体", english: "Body", lines: 1, of: 2 },
  ]);
  const flagged = Object.fromEntries(
    result.findings.map((group) => [group.check, group.examples.map((entry) => entry.id)]),
  );
  assert.deepStrictEqual(flagged, {
    "source text left": ["entry8"],
    "speaker name repeated": ["entry14"],
    "number added on a last line": ["entry15"],
    refusal: [],
    "length unlike the source": ["entry20"],
    "| unlike the source": [],
    // The check leaves out terms the model hasn't sorted, which may be names.
    "glossary name missing": ["entry16"],
    "pronoun unlike the source": ["entry18"],
    "plural after a number": [],
    "no space after a value": [],
  });
  assert.isUndefined(result.run);
});

const counts = (groups: ReadonlyArray<{ reason: string; count: number }>) =>
  Object.fromEntries(groups.map((group) => [group.reason, group.count]));

it("With a run log, the audit summarises the run, its rejections and the answers changed since", () => {
  const answered = line(4, "进入仓库", "Enter the storehouse");
  const log = runLog("run.log", [
    {
      type: "run",
      started,
      translator: "ollama",
      kind: "translate",
      model: "m",
      glossaryModel: "m",
      numCtx: 4096,
      sampling: "temperature-0",
      entries: 3,
    },
    request([red], ["placeholder missing"]),
    request([red], ["source text left"]),
    request([answered], [], "Go in"),
    { type: "ask", at: started, model: "m", system: "", user: "", error: "no answer", ms: 1 },
    { type: "warning", at: started, message: "Part of the model runs on the CPU." },
    { type: "end", at: started, translated: 1, failed: [red.id], stopped: false },
  ]);
  const fromRun = { modelTranslation: "Go in", modelOperationId: 1 };
  const edited = {
    ...withTexts(catalog, (text) =>
      text.source === answered.source ? { ...text, ...fromRun } : text,
    ),
    glossary: [
      ...catalog.glossary,
      testTerm(answered.source, { ...fromRun, userTranslation: "Enter" }),
      testTerm("雨", { modelTranslation: "Rain", modelOperationId: 1, rulesKind: "name" }),
      testTerm("风", {
        modelTranslation: "Wind",
        modelOperationId: 2,
        userTranslation: "Gale",
        rulesKind: "name",
      }),
    ],
    operations: [
      { id: 1, kind: "run" as const, startedAt: started },
      { id: 2, kind: "run" as const, startedAt: "2026-09-01T00:00:00.000Z" },
    ],
  };
  const run = audit(edited, log).run;
  assert.deepStrictEqual(run?.summary, {
    file: "run.log",
    ...(log.start && { start: log.start }),
    ...(log.end && { end: log.end }),
    warnings: ["Part of the model runs on the CPU."],
    requests: 3,
    asks: 1,
    failedAsks: 1,
    answers: 1,
  });
  assert.deepStrictEqual(run?.corrections, {
    of: 3,
    count: 2,
    examples: [
      {
        of: "translation",
        id: answered.id,
        source: answered.source,
        modelTranslation: "Go in",
        user: "Enter the storehouse",
      },
      {
        of: "termTranslation",
        id: answered.source,
        source: answered.source,
        modelTranslation: "Go in",
        user: "Enter",
      },
    ],
  });
  assert.deepStrictEqual(counts(run?.rejections.all ?? []), {
    "placeholder missing": 1,
    "source text left": 1,
  });
  assert.deepStrictEqual(counts(run?.rejections.untranslated ?? []), { "source text left": 1 });

  assert.deepStrictEqual([...runAnswers(log).keys()], [answered.id]);
  assert.deepStrictEqual(runTotals(log, catalog.glossary, "chinese", "MV"), {
    file: "run.log",
    ...(log.start && { start: log.start }),
    answers: 1,
    failed: 1,
    rejected: { "placeholder missing": 1, "source text left": 1 },
    findings: {},
  });
});
