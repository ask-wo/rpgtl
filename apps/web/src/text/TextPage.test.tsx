import { useAtomValue } from "@effect/atom-react";
import type { Catalog, Entry, Findings, GameActivity, RunStatus } from "@rpgtl/contracts";
import { useState } from "react";
import { page } from "vite-plus/test/browser";
import { beforeAll, expect, test, vi } from "vite-plus/test";
import { GameContext } from "../games/GameContext.ts";
import { editsStatus } from "../games/edits.ts";
import { catalogFeed, events, render, serveApi } from "../testUtils/fakeApi.tsx";
import { game, idle } from "../testUtils/game.ts";
import type { TextSearch } from "./search.ts";
import { TextEditor } from "./TextPage.tsx";
import { entryTranslation } from "@rpgtl/domain";

// The file tree and the entries sit side by side, as on a desktop screen.
beforeAll(() => page.viewport(1280, 800));

const lastRun = "2026-11-04T10:00:00.000Z";

const line = (id: string, file: string, source: string, translation: string): Entry => ({
  id,
  file,
  path: ["events", "1", "pages", "0", "list", id],
  source,
  translation: translation ? { user: translation } : {},
});

const saved: Catalog = {
  version: 1,
  game: { id: game.id, title: game.title, engine: "MV" },
  entries: [
    { ...line("m1", "MapInfos.json", "客厅", "Living Room"), path: ["1", "name"] },
    { ...line("1", "Map001.json", "你好", "Hello"), speaker: "阿琳" },
    {
      ...line("2", "Map001.json", "下雨了", ""),
      suggestion: { text: "下雨 rain", reason: "source text left" },
    },
    {
      ...line("3", "Map002.json", "再见", ""),
      translation: { guess: { value: "Bye", run: lastRun } },
      previous: "Farewell",
    },
    line("4", "Items.json", "药水", "Potion"),
    line("5", "System.json", "开始", ""),
    line("6", "img/pictures/Title", "标题", ""),
  ],
  glossary: [
    { source: "阿琳", translation: { user: "Arlene" }, kind: { guess: { value: "character" } } },
  ],
  translate: true,
  lastRun,
};

/**
 * RPGTL's server with the game's catalog, its checks and its activity, which the test sends;
 * `saves` lists the entries the page saved. An English with "\\" in it is refused.
 */
const fakeServer = () => {
  const stream = events();
  const server = {
    catalog: saved,
    findings: { "4": [{ check: "length unlike the source" }] } as Findings,
    activity: (now: GameActivity) => stream.send(now),
    saves: [] as Array<ReadonlyArray<{ id: string; translation: string }>>,
    feed: catalogFeed(
      (): Catalog => server.catalog,
      (): Findings => ({
        ...server.findings,
        ...Object.fromEntries(
          server.catalog.entries
            .filter((entry) => /\p{Script=Han}/u.test(entryTranslation(entry)))
            .map((entry) => [entry.id, [{ check: "source text left" as const }]]),
        ),
      }),
    ),
  };
  serveApi(async (request) => {
    switch (new URL(request.url).pathname) {
      case "/api/activity":
        return stream.response();
      case "/api/catalog/changes":
        return server.feed.response();
      case "/api/entries": {
        const { entries } = await request.json();
        server.saves.push(entries);
        const [edit] = entries;
        if (edit.translation.includes("\\"))
          return Response.json(
            {
              _tag: "EntryRejected",
              id: edit.id,
              problem: "controlCodes",
              message: "Keep the original's RPG Maker control codes.",
            },
            { status: 400 },
          );
        server.catalog = {
          ...server.catalog,
          entries: server.catalog.entries.map((entry) =>
            entry.id === edit.id ? { ...entry, translation: { user: edit.translation } } : entry,
          ),
        };
        server.feed.changed();
        return new Response(null, { status: 204 });
      }
    }
    return new Response(null, { status: 404 });
  });
  return server;
};

/** Why the game's edits aren't saved, as the header says it. */
function SaveError() {
  const { error } = useAtomValue(editsStatus(game.id));
  return error ? <p>Not saved: {error}</p> : null;
}

/** The Text page with its address's search kept in state; `searches` lists each change. */
const showText = (start: TextSearch = {}) => {
  const searches: Array<TextSearch> = [];
  function Page() {
    const [search, setSearch] = useState(start);
    return (
      <TextEditor
        search={search}
        onSearch={(next) => {
          searches.push(next);
          setSearch(next);
        }}
      />
    );
  }
  render(
    <GameContext value={game}>
      <div className="flex h-svh flex-col">
        <SaveError />
        <Page />
      </div>
    </GameContext>,
  );
  return searches;
};

const tree = () => page.getByRole("navigation", { name: "Text files" });
const entries = () => page.getByRole("region", { name: "Entries" });

test("the tree lists the game's text files by area, and a file or a search narrows the entries", async () => {
  const server = fakeServer();
  const searches = showText();
  server.activity(idle);
  await expect.element(tree().getByRole("button", { name: "All files 6" })).toBeVisible();
  await expect
    .element(tree().getByRole("button", { name: "Map001 · Living Room 2" }))
    .toBeVisible();
  await expect.element(tree().getByRole("button", { name: "Database 2" })).toBeVisible();
  await expect.element(tree().getByText("Title")).not.toBeInTheDocument();
  await expect.element(entries().getByText("Map001 · Living Room · Arlene")).toBeVisible();

  await tree().getByRole("button", { name: "Map002 1" }).click();
  expect(searches.at(-1)).toEqual({ file: "Map002.json" });
  await expect.element(entries().getByText("再见")).toBeVisible();
  await expect.element(entries().getByText("你好")).not.toBeInTheDocument();

  await tree()
    .getByRole("button", { name: /^All files/ })
    .click();
  await page.getByRole("searchbox", { name: "Search the text" }).fill("potion");
  expect(searches.at(-1)).toEqual({ q: "potion" });
  await expect.element(tree().getByRole("button", { name: "All files 1" })).toBeVisible();
  await expect.element(tree().getByRole("button", { name: /^Map001/ })).not.toBeInTheDocument();
  await expect.element(entries().getByText("药水")).toBeVisible();
  await expect.element(page.getByText("1 entry · page 1 of 1")).toBeVisible();
});

test("an edit saves once typing pauses, and stays listed while it leaves the filter", async () => {
  const server = fakeServer();
  const searches = showText();
  server.activity(idle);
  await page.getByRole("button", { name: /^Untranslated/ }).click();
  expect(searches.at(-1)).toEqual({ show: "untranslated" });
  const box = page.getByRole("textbox", { name: "English for 开始" });
  await box.fill("Start 开始");
  await vi.waitFor(() => expect(server.saves).toEqual([[{ id: "5", translation: "Start 开始" }]]));
  await expect.element(page.getByRole("button", { name: "Untranslated 1" })).toBeVisible();
  await expect.element(box).toHaveValue("Start 开始");
  // The checks are read again once the edit saved.
  await expect.element(page.getByRole("button", { name: "Flagged 2" })).toBeVisible();

  await box.fill("\\Start");
  await expect
    .element(entries().getByText("Keep the original's RPG Maker control codes."))
    .toBeVisible();
  await expect.element(box).toHaveAttribute("aria-invalid", "true");

  // Another edit that saves leaves the refused one unsaved, named, and listed in any view.
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: /^All/ }).click();
  await page.getByRole("textbox", { name: "English for 药水" }).fill("Potion!");
  await vi.waitFor(() => expect(server.saves).toHaveLength(3));
  await expect
    .element(page.getByText("Not saved: 开始: Keep the original's RPG Maker control codes."))
    .toBeVisible();
  await page.getByRole("searchbox", { name: "Search the text" }).fill("potion");
  await expect.element(box).toBeVisible();
});

test("Failed, Last run and Flagged show what a run or a check left on the entries", async () => {
  const server = fakeServer();
  showText({ show: "failed" });
  const failedRun: RunStatus = {
    kind: "translate",
    phase: { _tag: "Finished" },
    total: 2,
    done: 1,
    translated: 1,
    failed: ["5"],
    left: 0,
    warnings: [],
  };
  server.activity({ ...idle, translation: failedRun });
  await expect.element(entries().getByText("开始")).toBeVisible();
  await expect
    .element(entries().getByText("Rejected answer (source text left):", { exact: false }))
    .toBeVisible();
  await entries().getByRole("button", { name: "Use" }).click();
  await expect
    .element(page.getByRole("textbox", { name: "English for 下雨了" }))
    .toHaveValue("下雨 rain");

  await page.getByRole("button", { name: /^Last run/ }).click();
  await expect.element(entries().getByText("Before the last run:", { exact: false })).toBeVisible();
  await entries().getByRole("button", { name: "Use the old one" }).click();
  await expect
    .element(page.getByRole("textbox", { name: "English for 再见" }))
    .toHaveValue("Farewell");

  await page.getByRole("button", { name: /^Flagged/ }).click();
  await expect
    .element(
      entries().getByText("Check: length unlike the source. Editing the English clears this."),
    )
    .toBeVisible();
});

test("while a run goes the English can't be edited", async () => {
  const server = fakeServer();
  showText();
  server.activity({
    ...idle,
    translation: {
      kind: "translate",
      phase: { _tag: "Running" },
      total: 2,
      done: 0,
      translated: 0,
      failed: [],
      left: 2,
      warnings: [],
    },
  });
  await expect.element(page.getByRole("textbox", { name: "English for 你好" })).toBeDisabled();
  server.activity(idle);
  await expect.element(page.getByRole("textbox", { name: "English for 你好" })).toBeEnabled();
});
