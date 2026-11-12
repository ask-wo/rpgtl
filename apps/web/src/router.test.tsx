import type { Catalog } from "@rpgtl/contracts";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { page } from "vite-plus/test/browser";
import { beforeAll, expect, test } from "vite-plus/test";
import { createAppRouter } from "./router.tsx";
import { catalogFeed, events, render, serveApi } from "./testUtils/fakeApi.tsx";
import { game, idle } from "./testUtils/game.ts";

beforeAll(() => page.viewport(1280, 800));

const saved: Catalog = {
  version: 1,
  game: { id: game.id, title: game.title, engine: "MV" },
  entries: [
    {
      id: "1",
      location: { _tag: "MapName", map: 1 },
      source: "你好",
      translation: { user: "Hello" },
    },
    {
      id: "2",
      location: { _tag: "RecordField", table: "items", record: 2, field: "name" },
      source: "药水",
      translation: {},
    },
  ],
  glossary: [],
  translate: true,
};

test("the bar's link after a run opens the Text page on the failed entries, and the address keeps it", async () => {
  const stream = events();
  serveApi((request) => {
    switch (new URL(request.url).pathname) {
      case "/api/games":
        return Response.json([game]);
      case "/api/activity":
        return stream.response();
      case "/api/catalog/changes":
        return catalogFeed(() => saved).response();
      case "/api/settings":
        return Response.json({});
    }
    return new Response(null, { status: 404 });
  });
  const history = createMemoryHistory({ initialEntries: [`/games/${game.id}`] });
  render(<RouterProvider router={createAppRouter(history)} />);
  stream.send({
    ...idle,
    translation: {
      kind: "translate",
      phase: { _tag: "Finished" },
      total: 1,
      done: 0,
      translated: 1,
      failed: ["2"],
      left: 0,
      warnings: [],
    },
  });
  await page.getByRole("button", { name: "Show the 1 failed text entry" }).click();
  await expect
    .element(page.getByRole("button", { name: "Failed 1" }))
    .toHaveAttribute("aria-pressed", "true");
  expect(history.location.pathname).toBe(`/games/${game.id}/text`);
  expect(history.location.search).toBe("?show=failed");
  await expect.element(page.getByRole("textbox", { name: "English for 药水" })).toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "English for 你好" }))
    .not.toBeInTheDocument();

  await page.getByRole("searchbox", { name: "Search the text" }).fill("12");
  await expect.poll(() => history.location.search).toBe("?q=12&show=failed");
});
