import type { Catalog, GameActivity, GlossaryTerm, RunStatus, TermEdit } from "@rpgtl/contracts";
import { withGlossary, withTermTranslationsCleared } from "@rpgtl/domain";
import { testCatalog, type TestEntry, testTerm } from "@rpgtl/domain/testUtils/catalog";
import { Result } from "effect";
import * as Struct from "effect/Struct";
import { page } from "vite-plus/test/browser";
import { beforeAll, expect, test, vi } from "vite-plus/test";
import { GameContext } from "../games/GameContext.ts";
import { catalogFeed, events, render, serveApi } from "../testUtils/fakeApi.tsx";
import { game, idle } from "../testUtils/game.ts";
import { GlossaryPage } from "./GlossaryPage.tsx";

// The list and the term's details sit side by side, as on a desktop screen.
beforeAll(() => page.viewport(1280, 800));

const line = (id: string, source: string, translation: string): TestEntry => ({
  id,
  location: {
    _tag: "Message",
    list: { _tag: "MapEventPage", map: 1, event: 1, page: 0 },
    index: Number(id),
  },
  source,
  ...(translation && { userTranslation: translation }),
});

/** The id of the run that gave the model's values in these tests. */
const run = 1;
const arlene: GlossaryTerm = testTerm("阿琳", {
  modelTranslation: "Arlene",
  modelOperationId: run,
  rulesKind: "character",
  modelKind: "character",
  rulesPronoun: "she",
  sheClues: 3,
  heClues: 0,
});
const rain = testTerm("雨", { userTranslation: "Rain", rulesKind: "name" });

const savedEntries = [
  line("1", "阿琳来了", "Arlene is here"),
  line("2", "阿琳走了", "Irene left"),
  line("3", "下雨了", ""),
];
const catalogOf = ({
  entries = savedEntries,
  glossary = [rain, arlene],
}: {
  readonly entries?: ReadonlyArray<TestEntry>;
  readonly glossary?: ReadonlyArray<GlossaryTerm>;
} = {}): Catalog =>
  testCatalog({
    game: { id: game.id, title: game.title, engine: "MV" },
    entries,
    glossary,
    settings: { isTranslationOn: true },
    operations: [{ id: run, kind: "run", startedAt: "2026-11-04T10:00:00.000Z" }],
  });
const saved = catalogOf();

const busy = () =>
  Response.json(
    { _tag: "GameBusy", message: "This game is busy. Wait for the current operation." },
    { status: 400 },
  );

/**
 * RPGTL's server with the game's catalog and its activity, which the test sends; `glossaries`
 * lists the glossaries the page saved, `cleared` the sources it cleared mismatches of and
 * `clearedAll` those it cleared every line of.
 */
const fakeServer = () => {
  const stream = events();
  const server = {
    catalog: saved,
    activity: (now: GameActivity) => stream.send(now),
    glossaries: [] as Array<ReadonlyArray<TermEdit>>,
    cleared: [] as Array<ReadonlyArray<string>>,
    clearedAll: [] as Array<ReadonlyArray<string>>,
    clearedTranslations: [] as Array<ReadonlyArray<string>>,
    /** Whether the next save or clear is refused as if a run held the game. */
    busy: false,
    /** What a refused save waits for before it answers. */
    held: Promise.resolve(),
    feed: catalogFeed((): Catalog => server.catalog),
  };
  serveApi(async (request) => {
    switch (new URL(request.url).pathname) {
      case "/api/activity":
        return stream.response();
      case "/api/catalog/changes":
        return server.feed.response();
      case "/api/glossary": {
        const { glossary } = await request.json();
        server.glossaries.push(glossary);
        if (server.busy) {
          server.busy = false;
          await server.held;
          return busy();
        }
        server.catalog = Result.getOrThrow(withGlossary(server.catalog, glossary));
        server.feed.changed();
        return new Response(null, { status: 204 });
      }
      case "/api/glossary/clear-lines": {
        const { sources, mismatchesOnly } = await request.json();
        (mismatchesOnly ? server.cleared : server.clearedAll).push(sources);
        await server.held;
        if (server.busy) {
          server.busy = false;
          return busy();
        }
        return Response.json({ cleared: 1 });
      }
      case "/api/glossary/clear-translations": {
        const { sources } = await request.json();
        server.clearedTranslations.push(sources);
        const { catalog, terms, texts } = withTermTranslationsCleared(server.catalog, sources);
        server.catalog = catalog;
        server.feed.changed();
        return Response.json({ terms, texts });
      }
    }
    return new Response(null, { status: 404 });
  });
  return server;
};

const showGlossary = () =>
  render(
    <GameContext value={game}>
      <div className="flex h-svh flex-col">
        <GlossaryPage />
      </div>
    </GameContext>,
  );

test("terms are listed by kind, and a term shows where it came from and the entries that use it", async () => {
  const server = fakeServer();
  showGlossary();
  server.activity(idle);
  const characters = page.getByRole("region", { name: "Characters" });
  await expect.element(characters.getByText("Characters · 1")).toBeVisible();
  await expect.element(characters.getByText("Arlene")).toBeVisible();
  await expect.element(characters.getByText("she")).toBeVisible();
  await expect.element(page.getByRole("region", { name: "Names" }).getByText("Rain")).toBeVisible();

  await expect.element(page.getByLabelText("English")).toHaveValue("Arlene");
  await expect.element(page.getByText("Sorted by the model.")).toBeVisible();
  await expect.element(page.getByText("From the text: 3 clues for she, 0 for he.")).toBeVisible();
  await expect.element(page.getByText("Used in 2 entries")).toBeVisible();
  await expect.element(page.getByText("Irene left")).toBeVisible();

  await page.getByLabelText("Filter terms").fill("rain");
  await expect.element(page.getByRole("region", { name: "Characters" })).not.toBeInTheDocument();
});

test("a character's uses count the short forms of its name the translator knows", async () => {
  const server = fakeServer();
  server.catalog = catalogOf({
    entries: [
      line("1", "藤原·美咲来了", ""),
      line("2", "美咲走了", ""),
      line("3", "藤原先生", ""),
      line("4", "下雨了", ""),
    ],
    glossary: [
      testTerm("藤原·美咲", { userTranslation: "Fujiwara Misaki", rulesKind: "character" }),
    ],
  });
  server.feed.changed();
  showGlossary();
  server.activity(idle);
  await expect
    .element(page.getByText("Used in 3 entries, counting its short forms 藤原 and 美咲"))
    .toBeVisible();
  await expect.element(page.getByText("美咲走了")).toBeVisible();
});

test("typing saves once it pauses, and a new kind saves at once without the pronoun", async () => {
  const server = fakeServer();
  showGlossary();
  server.activity(idle);
  const english = page.getByLabelText("English");
  await english.fill("Arlena");
  await expect
    .element(page.getByRole("region", { name: "Characters" }).getByText("Arlena"))
    .toBeVisible();
  expect(server.glossaries).toEqual([]);
  await vi.waitFor(() => expect(server.glossaries).toHaveLength(1));
  expect(server.glossaries[0]).toEqual([
    { source: "雨", userTranslation: "Rain" },
    { source: "阿琳", userTranslation: "Arlena" },
  ]);

  await page.getByRole("combobox", { name: "Kind" }).click();
  await page.getByRole("option", { name: "Name" }).click();
  await vi.waitFor(() => expect(server.glossaries).toHaveLength(2));
  expect(server.glossaries[1]?.[1]).toEqual({
    source: "阿琳",
    userTranslation: "Arlena",
    userKind: "name",
  });
  await expect.element(page.getByText("Set by you.")).toBeVisible();
});

test("renaming a term renames it in the terms that contain it", async () => {
  const server = fakeServer();
  const umbrella = testTerm("阿琳的伞", {
    modelTranslation: "Arlene's Umbrella",
    modelOperationId: run,
    rulesKind: "name",
  });
  server.catalog = catalogOf({ glossary: [arlene, umbrella] });
  showGlossary();
  server.activity(idle);
  const english = page.getByLabelText("English");
  await english.fill("Arlena");
  await expect.element(page.getByText("Arlena's Umbrella")).toBeVisible();
  await english.fill("");
  await vi.waitFor(() =>
    expect(server.glossaries.at(-1)?.[0]).toEqual({ source: "阿琳", userTranslation: "" }),
  );
  await english.fill("Irene");
  await expect.element(page.getByText("Irene's Umbrella")).toBeVisible();
});

test("a cleared term offers its English from before, and using it saves that", async () => {
  const server = fakeServer();
  const untranslated = Struct.omit(arlene, ["modelTranslation", "modelOperationId"]);
  server.catalog = catalogOf({
    glossary: [rain, { ...untranslated, previousTranslation: "Arlene" }],
  });
  showGlossary();
  server.activity(idle);
  await expect.element(page.getByText(/Before clearing/)).toBeVisible();
  await page.getByRole("button", { name: "Use it" }).click();
  await vi.waitFor(() => expect(server.glossaries).toHaveLength(1));
  expect(server.glossaries[0]?.[1]).toEqual({ source: "阿琳", userTranslation: "Arlene" });
  await expect.element(page.getByText(/Before clearing/)).not.toBeInTheDocument();
});

test("Untranslated and Last run show only the terms without English and those the last run gave", async () => {
  const server = fakeServer();
  server.catalog = catalogOf({ glossary: [rain, arlene, testTerm("米娅", { rulesKind: "name" })] });
  showGlossary();
  server.activity(idle);
  const terms = page.getByRole("region", { name: "Glossary terms" });
  await page.getByRole("button", { name: "Untranslated 1" }).click();
  await expect.element(terms.getByText("米娅")).toBeVisible();
  await expect.element(terms.getByText("阿琳")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Last run 1" }).click();
  await expect.element(terms.getByText("阿琳")).toBeVisible();
  await expect.element(terms.getByText("米娅")).not.toBeInTheDocument();
});

test("Changed shows only the terms whose English differs from before clearing, with the old one", async () => {
  const server = fakeServer();
  server.catalog = catalogOf({ glossary: [rain, { ...arlene, previousTranslation: "Irene" }] });
  showGlossary();
  server.activity(idle);
  const terms = page.getByRole("region", { name: "Glossary terms" });
  await page.getByRole("button", { name: "Changed 1" }).click();
  await expect.element(terms.getByText("阿琳")).toBeVisible();
  await expect.element(terms.getByText("雨")).not.toBeInTheDocument();
  await expect.element(page.getByText(/Before the last run:/)).toBeVisible();
});

test("Flagged shows the terms whose English leaves out a name inside them, and names it", async () => {
  const server = fakeServer();
  server.catalog = catalogOf({
    glossary: [
      rain,
      arlene,
      testTerm("阿琳之歌", { userTranslation: "Irene's Song", rulesKind: "name" }),
    ],
  });
  showGlossary();
  server.activity(idle);
  const terms = page.getByRole("region", { name: "Glossary terms" });
  await page.getByRole("button", { name: "Flagged 1" }).click();
  await expect.element(terms.getByText("雨")).not.toBeInTheDocument();
  await terms.getByText("阿琳之歌").click();
  await expect.element(page.getByText(/inside it: 阿琳 → Arlene/)).toBeVisible();
});

const song = (source: string, english: string, typed: boolean) =>
  testTerm(source, {
    rulesKind: "name",
    ...(typed
      ? { userTranslation: english }
      : { modelTranslation: english, modelOperationId: run }),
  });

test("Clear flagged clears the flagged terms listed that a run gave English, not those the user typed, and shows them cleared after an edit", async () => {
  const server = fakeServer();
  server.catalog = catalogOf({
    entries: [
      ...savedEntries,
      { ...line("4", "阿琳之歌", ""), modelTranslation: "Irene's Song", modelOperationId: run },
    ],
    glossary: [
      rain,
      arlene,
      song("阿琳之歌", "Irene's Song", false),
      song("阿琳之梦", "Irene's Dream", true),
    ],
  });
  showGlossary();
  server.activity(idle);
  await page.getByLabelText("English").fill("Arlena");
  await vi.waitFor(() => expect(server.glossaries).toHaveLength(1));
  await page.getByRole("button", { name: "Flagged 2" }).click();
  await page.getByRole("button", { name: "Clear flagged" }).click();
  await expect
    .element(page.getByText("Cleared 1 term and 1 translation", { exact: false }))
    .toBeVisible();
  expect(server.clearedTranslations).toEqual([["阿琳之歌"]]);
  await page.getByRole("button", { name: /^All/ }).click();
  const terms = page.getByRole("region", { name: "Glossary terms" });
  await expect.element(terms.getByText("阿琳之歌")).toBeVisible();
  await expect.element(terms.getByText("Irene's Song")).not.toBeInTheDocument();
});

test("Custom shows the terms you set, and removing the glossary can keep them", async () => {
  const server = fakeServer();
  showGlossary();
  server.activity(idle);
  const terms = page.getByRole("region", { name: "Glossary terms" });
  await page.getByRole("button", { name: "Custom 1" }).click();
  await expect.element(terms.getByText("雨")).toBeVisible();
  await expect.element(terms.getByText("阿琳")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Remove glossary…" }).click();
  await expect
    .element(page.getByRole("checkbox", { name: "Keep the 1 term you set yourself" }))
    .toBeChecked();
  await page.getByRole("button", { name: "Remove glossary", exact: true }).click();
  await vi.waitFor(() =>
    expect(server.glossaries.at(-1)).toEqual([{ source: "雨", userTranslation: "Rain" }]),
  );
});

test("a term used in more entries than the list holds shows the rest on request", async () => {
  const server = fakeServer();
  server.catalog = catalogOf({
    entries: Array.from({ length: 101 }, (_, i) => line(String(i), `阿琳${i}号`, "")),
  });
  showGlossary();
  server.activity(idle);
  const uses = page.getByRole("region", { name: "Entries that use the term" });
  await expect.element(uses.getByText("阿琳99号")).toBeVisible();
  await expect.element(uses.getByText("阿琳100号")).not.toBeInTheDocument();
  await uses.getByRole("button", { name: "Show the other 1" }).click();
  await expect.element(uses.getByText("阿琳100号")).toBeVisible();
});

test("a new term saves once it has an original", async () => {
  const server = fakeServer();
  showGlossary();
  server.activity(idle);
  await page.getByRole("button", { name: "Add term" }).click();
  await expect
    .element(page.getByText("Type the original to see where the game uses it"))
    .toBeVisible();
  await vi.waitFor(() => expect(server.glossaries).toHaveLength(1));
  expect(server.glossaries[0]).toEqual([
    { source: "雨", userTranslation: "Rain" },
    { source: "阿琳" },
  ]);

  await page.getByLabelText("Original").fill("下雨");
  await page.getByLabelText("English").fill("Raining");
  await page.getByLabelText("Filter terms").click();
  await vi.waitFor(() =>
    expect(server.glossaries.at(-1)).toEqual([
      { source: "雨", userTranslation: "Rain" },
      { source: "阿琳" },
      { source: "下雨", userTranslation: "Raining" },
    ]),
  );
});

test("clearing a term's mismatches saves the glossary first and says how many it cleared", async () => {
  const server = fakeServer();
  showGlossary();
  server.activity(idle);
  await page.getByLabelText("English").fill("Arlena");
  await page.getByRole("button", { name: "Clear wrong text" }).click();
  await expect
    .element(
      page.getByText(
        "Cleared 1 translation of 阿琳 that didn't use Arlena. Translate translates it again.",
        { exact: false },
      ),
    )
    .toBeVisible();
  expect(server.glossaries).toHaveLength(1);
  expect(server.cleared).toEqual([["阿琳"]]);

  await page.getByRole("button", { name: "Clear all wrong text" }).click();
  await vi.waitFor(() => expect(server.cleared).toEqual([["阿琳"], ["阿琳"]]));
});

test("a clear that failed can be tried again", async () => {
  const server = fakeServer();
  showGlossary();
  server.activity(idle);
  server.busy = true;
  const clear = page.getByRole("button", { name: "Clear wrong text" });
  await clear.click();
  await expect.element(page.getByText("This game is busy.", { exact: false })).toBeVisible();
  await clear.click();
  await expect.element(page.getByText("Cleared 1 translation", { exact: false })).toBeVisible();
  expect(server.cleared).toEqual([["阿琳"], ["阿琳"]]);
});

test("an edit a run refused after taking over is dropped with the draft, and doesn't hold up clearing afterwards", async () => {
  const server = fakeServer();
  showGlossary();
  server.activity(idle);
  server.busy = true;
  const { promise: held, resolve: answer } = Promise.withResolvers<void>();
  server.held = held;
  await page.getByLabelText("English").fill("Arlena");
  await vi.waitFor(() => expect(server.glossaries).toHaveLength(1));
  const running: RunStatus = {
    kind: "translate" as const,
    phase: { _tag: "Running" },
    total: 1,
    done: 0,
    pass: "text",
    names: { total: 0, done: 0, failed: 0 },
    translated: 1,
    failed: [],
    left: 1,
    warnings: [],
  };
  server.activity({ ...idle, translation: running });
  await expect.element(page.getByLabelText("English")).toHaveValue("Arlene");
  answer();
  server.activity({ ...idle, translation: { ...running, phase: { _tag: "Finished" } } });
  await page.getByRole("button", { name: "Clear wrong text" }).click();
  await expect.element(page.getByText("Cleared 1 translation", { exact: false })).toBeVisible();
  expect(server.cleared).toEqual([["阿琳"]]);
});

test("a model's pronoun the text argues against waits for you to confirm it", async () => {
  const server = fakeServer();
  server.catalog = catalogOf({
    glossary: [{ ...arlene, modelPronoun: "he" }],
  });
  server.feed.changed();
  showGlossary();
  server.activity(idle);
  await expect
    .element(page.getByText("Translations don't use it until you confirm it.", { exact: false }))
    .toBeVisible();
  await page.getByRole("button", { name: "Confirm he" }).click();
  await vi.waitFor(() => expect(server.glossaries).toHaveLength(1));
  expect(server.glossaries[0]).toEqual([{ source: "阿琳", userPronoun: "he" }]);
});

test("Remove glossary without keeping your terms empties the glossary and closes its dialog", async () => {
  const server = fakeServer();
  showGlossary();
  server.activity(idle);
  await page.getByRole("button", { name: "Remove glossary…" }).click();
  await page.getByRole("checkbox", { name: "Keep the 1 term you set yourself" }).click();
  await page.getByRole("button", { name: "Remove glossary", exact: true }).click();
  await vi.waitFor(() => expect(page.getByRole("alertdialog").query()).toBeNull());
  await vi.waitFor(() => expect(server.glossaries).toEqual([[]]));
});

test("Remove all asks first, and the glossary is locked while a run goes", async () => {
  const server = fakeServer();
  showGlossary();
  server.activity(idle);
  await page.getByRole("button", { name: "Remove glossary…" }).click();
  await page.getByRole("button", { name: "Keep it" }).click();
  await vi.waitFor(() => expect(page.getByRole("alertdialog").query()).toBeNull());
  expect(server.glossaries).toEqual([]);

  server.activity({
    ...idle,
    translation: {
      kind: "build-glossary",
      phase: { _tag: "Running" },
      total: 1,
      done: 0,
      pass: "names",
      names: { total: 1, done: 0, failed: 0 },
      translated: 1,
      failed: [],
      left: 1,
      warnings: [],
    },
  });
  await expect.element(page.getByRole("button", { name: "Remove glossary…" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Add term" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Clear wrong text" })).toBeDisabled();
});

test("the × on a term asks first, then removes only that term", async () => {
  const server = fakeServer();
  showGlossary();
  server.activity(idle);
  await page.getByRole("button", { name: "Remove 雨 from the glossary" }).click();
  await page.getByRole("button", { name: "Keep it" }).click();
  await vi.waitFor(() => expect(page.getByRole("alertdialog").query()).toBeNull());
  expect(server.glossaries).toEqual([]);
  await page.getByRole("button", { name: "Remove 雨 from the glossary" }).click();
  await expect.element(page.getByText("Its lines keep their translations.")).toBeVisible();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await vi.waitFor(() => expect(server.glossaries).toEqual([[{ source: "阿琳" }]]));
  expect(server.cleared).toEqual([]);
  expect(server.clearedAll).toEqual([]);
});

test("a run that takes the game closes a waiting removal, which doesn't come back after it", async () => {
  const server = fakeServer();
  showGlossary();
  server.activity(idle);
  await page.getByRole("button", { name: "Remove 雨 from the glossary" }).click();
  await expect.element(page.getByText("Its lines keep their translations.")).toBeVisible();
  const running: RunStatus = {
    kind: "build-glossary",
    phase: { _tag: "Running" },
    total: 1,
    done: 0,
    pass: "names",
    names: { total: 1, done: 0, failed: 0 },
    translated: 1,
    failed: [],
    left: 1,
    warnings: [],
  };
  server.activity({ ...idle, translation: running });
  await vi.waitFor(() => expect(page.getByRole("alertdialog").query()).toBeNull());
  server.activity({ ...idle, translation: { ...running, phase: { _tag: "Finished" } } });
  await expect.element(page.getByRole("button", { name: "Remove glossary…" })).toBeEnabled();
  expect(page.getByRole("alertdialog").query()).toBeNull();
  expect(server.glossaries).toEqual([]);
});

test("a clear waits for its answer before another can be sent", async () => {
  const server = fakeServer();
  showGlossary();
  server.activity(idle);
  const { promise: held, resolve: answer } = Promise.withResolvers<void>();
  server.held = held;
  await page.getByRole("button", { name: "Clear wrong text" }).click();
  await expect.element(page.getByRole("button", { name: "Clear all wrong text" })).toBeDisabled();
  answer();
  await expect.element(page.getByText("Cleared 1 translation", { exact: false })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Clear all wrong text" })).toBeEnabled();
  expect(server.cleared).toEqual([["阿琳"]]);
});

test("Clear all text asks first with how many lines, then clears every line with the term", async () => {
  const server = fakeServer();
  showGlossary();
  server.activity(idle);
  await page.getByRole("button", { name: "Clear all text…" }).click();
  await expect
    .element(page.getByText("Clears 2 translated lines.", { exact: false }))
    .toBeVisible();
  await page.getByRole("button", { name: "Clear all text", exact: true }).click();
  await expect
    .element(page.getByText("Cleared 1 translation of 阿琳.", { exact: false }))
    .toBeVisible();
  expect(server.clearedAll).toEqual([["阿琳"]]);
  expect(server.cleared).toEqual([]);
});
