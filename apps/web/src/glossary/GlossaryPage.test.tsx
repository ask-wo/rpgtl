import type { Catalog, GameActivity, GlossaryTerm, RunStatus, TermEdit } from "@rpgtl/contracts";
import { withGlossary } from "@rpgtl/domain";
import { Result } from "effect";
import { page } from "vite-plus/test/browser";
import { beforeAll, expect, test, vi } from "vite-plus/test";
import { GameContext } from "../games/GameContext.ts";
import { catalogFeed, events, render, serveApi } from "../testUtils/fakeApi.tsx";
import { game, idle } from "../testUtils/game.ts";
import { GlossaryPage } from "./GlossaryPage.tsx";

// The list and the term's details sit side by side, as on a desktop screen.
beforeAll(() => page.viewport(1280, 800));

const line = (id: string, source: string, translation: string) => ({
  id,
  file: "Map001.json",
  path: ["events", "1", "pages", "0", "list", id],
  source,
  translation: translation ? { user: translation } : {},
});

const arlene: GlossaryTerm = {
  source: "阿琳",
  translation: { guess: { value: "Arlene", run: "r" } },
  kind: { guess: { value: "character", run: "r" } },
  pronoun: { guess: { value: "she", she: 3, he: 0 } },
};
const rain: GlossaryTerm = {
  source: "雨",
  translation: { user: "Rain" },
  kind: { guess: { value: "name" } },
};

const saved: Catalog = {
  version: 1,
  game: { id: game.id, title: game.title, engine: "MV" },
  entries: [
    line("1", "阿琳来了", "Arlene is here"),
    line("2", "阿琳走了", "Irene left"),
    line("3", "下雨了", ""),
  ],
  glossary: [rain, arlene],
  translate: true,
};

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
  server.catalog = {
    ...saved,
    entries: [
      line("1", "藤原·美咲来了", ""),
      line("2", "美咲走了", ""),
      line("3", "藤原先生", ""),
      line("4", "下雨了", ""),
    ],
    glossary: [
      {
        source: "藤原·美咲",
        translation: { user: "Fujiwara Misaki" },
        kind: { guess: { value: "character" } },
      },
    ],
  };
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
    { source: "雨", translation: "Rain" },
    { source: "阿琳", translation: "Arlena" },
  ]);

  await page.getByRole("combobox", { name: "Kind" }).click();
  await page.getByRole("option", { name: "Name" }).click();
  await vi.waitFor(() => expect(server.glossaries).toHaveLength(2));
  expect(server.glossaries[1]?.[1]).toEqual({
    source: "阿琳",
    translation: "Arlena",
    kind: "name",
  });
  await expect.element(page.getByText("Set by you.")).toBeVisible();
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
  expect(server.glossaries[0]).toEqual([{ source: "雨", translation: "Rain" }, { source: "阿琳" }]);

  await page.getByLabelText("Original").fill("下雨");
  await page.getByLabelText("English").fill("Raining");
  await page.getByLabelText("Filter terms").click();
  await vi.waitFor(() =>
    expect(server.glossaries.at(-1)).toEqual([
      { source: "雨", translation: "Rain" },
      { source: "阿琳" },
      { source: "下雨", translation: "Raining" },
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
  server.catalog = {
    ...saved,
    glossary: [{ ...arlene, pronoun: { guess: { value: "he", run: "r", she: 3, he: 0 } } }],
  };
  server.feed.changed();
  showGlossary();
  server.activity(idle);
  await expect
    .element(page.getByText("Translations don't use it until you confirm it.", { exact: false }))
    .toBeVisible();
  await page.getByRole("button", { name: "Confirm he" }).click();
  await vi.waitFor(() => expect(server.glossaries).toHaveLength(1));
  expect(server.glossaries[0]).toEqual([{ source: "阿琳", pronoun: "he" }]);
});

test("Remove glossary empties the glossary and closes its dialog", async () => {
  const server = fakeServer();
  showGlossary();
  server.activity(idle);
  await page.getByRole("button", { name: "Remove glossary…" }).click();
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
    .element(page.getByText("Clears 2 translated lines, after backing them up.", { exact: false }))
    .toBeVisible();
  await page.getByRole("button", { name: "Clear all text", exact: true }).click();
  await expect
    .element(page.getByText("Cleared 1 translation of 阿琳.", { exact: false }))
    .toBeVisible();
  expect(server.clearedAll).toEqual([["阿琳"]]);
  expect(server.cleared).toEqual([]);
});
