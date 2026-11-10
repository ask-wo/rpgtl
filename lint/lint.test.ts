import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test, vi } from "vite-plus/test";

// Each check runs `vp lint` once or more, which takes seconds while the other tests run.
vi.setConfig({ testTimeout: 30_000 });

const root = path.join(import.meta.dirname, "..");
const dir = mkdtempSync(path.join(tmpdir(), "rpgtl-lint-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

for (const file of ["vite.config.ts", "tsconfig.base.json", "lint/plugin.ts"])
  cpSync(path.join(root, file), path.join(dir, file));
symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"));
writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "probe", type: "module" }));
writeFileSync(
  path.join(dir, "tsconfig.json"),
  JSON.stringify({ extends: "./tsconfig.base.json", include: ["apps"] }),
);

const probe = `
export const parse = (text: string) => JSON.parse(text) as { a: number };
export const first = (list: number[]) => list[0]!;
export const loose = (value: any) => value;
export async function load() {
  try {
    await Promise.resolve(process.env.HOME);
  } catch {}
  return [Date.now(), new Date()];
}
`;

/**
 * The exit code of one `vp lint` run on `files` (path to code), and the rules it reports in each.
 * Each run takes about a second, so a test with several probes lints them together.
 */
function rulesIn(files: Record<string, string>) {
  for (const [file, code] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, file), code);
  }
  const result = spawnSync(
    path.join(root, "node_modules/.bin/effect-tsgo"),
    ["--tsrs-lint", "vp", "lint", "--format", "json", ...Object.keys(files)],
    { cwd: dir, encoding: "utf8" },
  );
  const report: { diagnostics: { code: string; severity: string; filename: string }[] } =
    JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  const rules = Object.fromEntries(
    Object.keys(files).map((file) => {
      const codes = report.diagnostics
        .filter((diagnostic) => diagnostic.severity === "error" && diagnostic.filename === file)
        .map((diagnostic) => diagnostic.code);
      return [file, [...new Set(codes)].toSorted()];
    }),
  );
  return { status: result.status, rules };
}

/** The exit code of `vp lint` on `code` placed at `file`, and the rules it reports. */
function rulesAt(file: string, code = probe) {
  const { status, rules } = rulesIn({ [file]: code });
  return { status, rules: rules[file] };
}

const everywhere = [
  "typescript(no-unsafe-type-assertion)",
  "typescript(no-non-null-assertion)",
  "typescript(no-explicit-any)",
];
const server = [
  "rpgtl(no-async)",
  "rpgtl(no-try)",
  "rpgtl(no-new-date)",
  "eslint(no-restricted-properties)",
];

test("server code may not use any, !, unchecked as, async, try, Date or process.env", () => {
  expect(rulesAt("apps/server/src/probe.ts")).toEqual({
    status: 1,
    rules: [...everywhere, ...server].toSorted(),
  });
});

test("server code may not iterate with for await", () => {
  const code = `import { createReadStream } from "node:fs";
for await (const chunk of createReadStream("file")) void chunk;
`;
  expect(rulesAt("apps/server/src/for-await.ts", code)).toEqual({
    status: 1,
    rules: ["rpgtl(no-async)"],
  });
});

test("other new code may use async, try, Date and process.env, but not any, ! or unchecked as", () => {
  expect(rulesAt("packages/domain/src/probe.ts")).toEqual({
    status: 1,
    rules: everywhere.toSorted(),
  });
});

test("the game scripts may use any, ! and unchecked as, which patching the engine needs", () => {
  expect(rulesAt("packages/game/src/probe.ts")).toEqual({ status: 0, rules: [] });
});

test("new code imports Effect modules as namespaces from their own paths", () => {
  const imports = [
    'import { Effect } from "effect";',
    'import * as Http from "effect/http";',
    'import { NodeServices } from "@effect/platform-node";',
    'import { gen } from "effect/Effect";',
  ];
  const refused = rulesIn(
    Object.fromEntries(
      imports.map((line, index) => [
        `packages/domain/src/import${index}.ts`,
        `${line}\nexport const used = [${line.match(/(?:\* as |\{ )(\w+)/)?.[1]}];\n`,
      ]),
    ),
  );
  expect(refused.status).toBe(1);
  for (const rules of Object.values(refused.rules))
    expect(rules).toEqual(["rpgtl(effect-namespace-imports)"]);
  const allowed = `import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
export const used = [Effect, HttpRouter, NodeServices, it];
`;
  expect(rulesAt("apps/server/src/imports.ts", allowed)).toEqual({ status: 0, rules: [] });
});

test("a service's layer is exported from its module, not a static on the class", () => {
  for (const member of [
    "static readonly layer = Layer.empty;",
    "static layer() {\n    return Layer.empty;\n  }",
    "static get layer() {\n    return Layer.empty;\n  }",
  ])
    expect(
      rulesAt(
        "apps/server/src/Foo.ts",
        `import * as Layer from "effect/Layer";\nexport class Foo {\n  ${member}\n}\n`,
      ),
    ).toEqual({ status: 1, rules: ["rpgtl(no-static-layer)"] });
});

test("new code keeps its tests next to their modules", () => {
  const code = 'import { it } from "@effect/vitest";\nit("works", () => {});\n';
  expect(rulesAt("packages/domain/test/apply.test.ts", code)).toEqual({
    status: 1,
    rules: ["rpgtl(tests-next-to-module)"],
  });
  expect(rulesAt("packages/domain/src/apply.test.ts", code)).toEqual({ status: 0, rules: [] });
});

test("an error's message is not built from another error's message", () => {
  const failed =
    "class Failed {\n  constructor(readonly fields: { cause: Error; message: string }) {}\n}\n";
  for (const message of [
    "`Couldn't read: ${cause.message}`",
    "cause.message",
    '"Couldn\'t read: " + cause.message',
  ])
    expect(
      rulesAt(
        "apps/server/src/message.ts",
        `${failed}export const wrap = (cause: Error) => new Failed({ cause, message: ${message} });\n`,
      ),
    ).toEqual({ status: 1, rules: ["rpgtl(no-message-from-cause)"] });
  const getter = `export class Failed {
  constructor(readonly reason: Error) {}
  override get message() {
    return this.reason.message;
  }
}
`;
  expect(rulesAt("apps/server/src/getter.ts", getter)).toEqual({
    status: 1,
    rules: ["rpgtl(no-message-from-cause)"],
  });
  for (const code of [
    `${failed}export const wrap = (file: string, cause: Error) =>\n  new Failed({ cause, message: \`Couldn't read \${file}.\` });\n`,
    "export const shown = (notice: { message: string }) => ({ message: notice.message });\n",
  ])
    expect(rulesAt("apps/server/src/allowed.ts", code)).toEqual({ status: 0, rules: [] });
});

test("known errors are caught with Effect.catchTags", () => {
  const code = `import * as Effect from "effect/Effect";
export const recovered = Effect.fail(new Error("x")).pipe(Effect.catchTag("Error", () => Effect.void));
`;
  expect(rulesAt("apps/server/src/catch.ts", code)).toEqual({
    status: 1,
    rules: ["rpgtl(prefer-catch-tags)"],
  });
});

test("a record's keys are plain strings, so keys it doesn't allow fail instead of being dropped", () => {
  const keys = [
    "Schema.String.check(Schema.isPattern(/^img\\//))",
    'Schema.TemplateLiteral(["img/", Schema.String])',
    'Schema.Literals(["a", "b"])',
  ];
  for (const key of keys)
    expect(
      rulesAt(
        "packages/contracts/src/record.ts",
        `import * as Schema from "effect/Schema";\nexport const Images = Schema.Record(${key}, Schema.Number);\n`,
      ),
    ).toEqual({ status: 1, rules: ["rpgtl(record-keys-are-strings)"] });
  const allowed = `import * as Schema from "effect/Schema";
export const Images = Schema.Record(Schema.String, Schema.Number);
`;
  expect(rulesAt("packages/contracts/src/record.ts", allowed)).toEqual({ status: 0, rules: [] });
});

test("handlers that catch every failure are refused", () => {
  const read = `import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
export const exists = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem.asEffect(), (fs) => fs.exists(file)).pipe(`;
  for (const handler of [
    "Effect.orElseSucceed(() => false)",
    "Effect.option",
    "Effect.catch(() => Effect.succeed(false))",
  ])
    expect(rulesAt("apps/server/src/swallow.ts", `${read}\n    ${handler},\n  );\n`)).toEqual({
      status: 1,
      rules: ["rpgtl(no-catch-all)"],
    });
  const reasoned = `${read}
    // oxlint-disable-next-line rpgtl/no-catch-all -- a best-effort probe
    Effect.orElseSucceed(() => false),
  );
`;
  expect(rulesAt("apps/server/src/reasoned.ts", reasoned)).toEqual({ status: 0, rules: [] });
});

test("an error's cause is the failure underneath, not a literal", () => {
  const failed = `export class Failed {
  constructor(readonly fields: { file: string; cause: unknown }) {}
}
`;
  for (const cause of ['"missing"', "`missing`", "404"])
    expect(
      rulesAt(
        "apps/server/src/cause.ts",
        `${failed}export const missing = new Failed({ file: "a", cause: ${cause} });\n`,
      ),
    ).toEqual({ status: 1, rules: ["rpgtl(no-literal-cause)"] });
  expect(
    rulesAt(
      "apps/server/src/cause.ts",
      `${failed}export const wrap = (cause: Error) => new Failed({ file: "a", cause });\n`,
    ),
  ).toEqual({ status: 0, rules: [] });
});

test("a function returning Effect.gen is written with Effect.fn", () => {
  const wrapped = [
    "export const load = (id: string) => Effect.gen(function* () {\n  return yield* Effect.succeed(id);\n});",
    "export const load = (id: string) => {\n  return Effect.gen(function* () {\n    return yield* Effect.succeed(id);\n  }).pipe(Effect.orDie);\n};",
    "export function load(id: string) {\n  return Effect.gen(function* () {\n    return yield* Effect.succeed(id);\n  });\n}",
  ];
  for (const code of wrapped)
    expect(
      rulesAt("apps/server/src/gen.ts", `import * as Effect from "effect/Effect";\n${code}\n`),
    ).toEqual({ status: 1, rules: ["rpgtl(prefer-effect-fn)"] });
  const allowed = `import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
export const load = Effect.fn("load")(function* (id: string) {
  return yield* Effect.succeed(id);
});
export const program = Effect.gen(function* () {
  return yield* Effect.succeed(1);
});
export const Retries = Context.Reference<number>("Retries", {
  defaultValue: () => Effect.gen(function* () {
    return yield* Effect.succeed(3);
  }),
});
export const reported = Effect.void.pipe(
  Effect.matchCauseEffect({
    onFailure: () => Effect.gen(function* () {
      yield* Effect.void;
    }),
    onSuccess: () => Effect.gen(function* () {
      yield* Effect.void;
    }),
  }),
);
export const recovered = Effect.fail(new Error("x")).pipe(
  Effect.catchTags({ Error: () => Effect.gen(function* () {
    yield* Effect.void;
  }) }),
);
`;
  expect(rulesAt("apps/server/src/gen.ts", allowed)).toEqual({ status: 0, rules: [] });
});

const serviceWithId = (id: string) => `import * as Context from "effect/Context";
export class Games extends Context.Service<Games, string>()("${id}") {}
`;

test("a service's id names its package, folder and class", () => {
  expect(
    rulesAt("apps/server/src/games/Games.ts", serviceWithId("@rpgtl/server/http/Games")),
  ).toEqual({
    status: 1,
    rules: ["rpgtl(service-id-matches-path)"],
  });
  expect(
    rulesAt("apps/server/src/games/Games.ts", serviceWithId("@rpgtl/server/games/Games")),
  ).toEqual({
    status: 0,
    rules: [],
  });
  expect(
    rulesAt("packages/contracts/src/main.ts", serviceWithId("@rpgtl/contracts/Games")),
  ).toEqual({
    status: 0,
    rules: [],
  });
});

const serviceWithMethods = (methods: string) => `import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
export class Clock extends Context.Service<
  Clock,
  { readonly now: Effect.Effect<number>; readonly wait: (ms: number) => Effect.Effect<void> }
>()("@rpgtl/server/time/Clock") {}
const make = Effect.gen(function* () {
  const now = yield* Effect.succeed(Effect.succeed(1));
  ${methods}
  return Clock.of({ now, wait });
});
export const layer = Layer.effect(Clock, make);
`;

test("a service's methods are written with Effect.fn", () => {
  expect(
    rulesAt(
      "apps/server/src/time/Clock.ts",
      serviceWithMethods("const wait = (ms: number) => Effect.sleep(ms);"),
    ),
  ).toEqual({ status: 1, rules: ["rpgtl(service-methods-effect-fn)"] });
  expect(
    rulesAt(
      "apps/server/src/time/Clock.ts",
      serviceWithMethods(
        'const wait = Effect.fn("Clock.wait")(function* (ms: number) {\n    yield* Effect.sleep(ms);\n  });',
      ),
    ),
  ).toEqual({ status: 0, rules: [] });
});

test("new code doesn't wait in real time, and tests say what to wait on instead", () => {
  const code = "export const wait = (done: () => void) => setTimeout(done, 10);\n";
  expect(rulesAt("apps/server/src/wait.test.ts", code)).toEqual({
    status: 1,
    rules: ["eslint(no-restricted-globals)"],
  });
  expect(rulesAt("apps/server/src/wait.ts", code)).toEqual({
    status: 1,
    rules: ["effecttsgo(global-timers)"],
  });
});
