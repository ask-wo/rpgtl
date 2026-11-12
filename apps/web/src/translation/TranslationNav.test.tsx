import type { Catalog, Entry, Location } from "@rpgtl/contracts";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { page } from "vite-plus/test/browser";
import { beforeAll, expect, test } from "vite-plus/test";
import { createAppRouter } from "../router.tsx";
import { catalogFeed, events, render, serveApi } from "../testUtils/fakeApi.tsx";
import { game, idle } from "../testUtils/game.ts";

beforeAll(() => page.viewport(1280, 800));

const entry = (id: string, location: Location, translation: string): Entry => ({
  id,
  location,
  source: `原文${id}`,
  translation: translation ? { user: translation } : {},
});
const text = (id: string, translation: string) =>
  entry(id, { _tag: "SystemText", keys: [id] }, translation);
const imageText = (id: string, file: string, translation: string) =>
  entry(id, { _tag: "ImageLines", image: file, lines: [0] }, translation);

const showNav = (saved: Catalog) => {
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
  render(
    <RouterProvider
      router={createAppRouter(createMemoryHistory({ initialEntries: [`/games/${game.id}`] }))}
    />,
  );
  stream.send(idle);
  return page.getByRole("list", { name: "Translation" });
};

const catalog = (entries: Catalog["entries"]): Catalog => ({
  version: 1,
  game: { id: game.id, title: game.title, engine: "MV" },
  entries,
  glossary: [{ source: "雨", translation: { user: "Rain" }, kind: { guess: { value: "name" } } }],
  translate: true,
});

test("the sidebar shows how many entries have English, or only the total once all do", async () => {
  const nav = showNav(
    catalog([
      text("1", "Hello"),
      text("2", "Potion"),
      text("5", "Shield"),
      imageText("3", "img/pictures/Sign", ""),
      imageText("4", "img/pictures/Logo", ""),
    ]),
  );
  await expect.element(nav.getByRole("link", { name: "Glossary 1" })).toBeVisible();
  await expect.element(nav.getByRole("link", { name: "Text 3" })).toBeVisible();
  await expect.element(nav.getByRole("link", { name: "Images 0/2" })).toBeVisible();
});
