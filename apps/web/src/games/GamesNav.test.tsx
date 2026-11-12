import type { Catalog, Game, ListedGame } from "@rpgtl/contracts";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { page } from "vite-plus/test/browser";
import { beforeAll, expect, test } from "vite-plus/test";
import { createAppRouter } from "../router.tsx";
import { catalogFeed, events, render, serveApi } from "../testUtils/fakeApi.tsx";
import { game, idle } from "../testUtils/game.ts";

beforeAll(() => page.viewport(1280, 800));

const moved: Game = { ...game, root: "/games/new/rain", webRoot: "/games/new/rain/www" };

const catalogOf = (listed: Game): Catalog => ({
  version: 1,
  game: { id: listed.id, title: listed.title, engine: "MV" },
  entries: [],
  glossary: [],
  translate: true,
});

/**
 * The folder at `path` on a computer whose only folder with anything in it is `/games/new`, which
 * holds the moved game; a path ending in `/..` stands for the folder above.
 */
const listing = (path: string) => {
  const at = path === "" ? "/home/player" : path.replace(/\/[^/]+\/\.\.$/, "");
  return {
    path: at,
    parent: at === "/" ? null : at.slice(0, at.lastIndexOf("/")) || "/",
    home: "/home/player",
    roots: ["/"],
    folders: at === "/games/new" ? [{ name: "rain", path: moved.root, game: true }] : [],
  };
};

/**
 * The page at `path` with RPGTL's server answering, listing `listed`; `browsed`, `moves` and
 * `inspected` list the folders the folder browser asked for, and the moves and rescans. With
 * `otherVersion`, opening a folder first asks whether it replaces the listed game.
 */
const showNav = (
  path = "/",
  {
    listed = {},
    otherVersion = false,
  }: { listed?: Partial<ListedGame>; otherVersion?: boolean } = {},
) => {
  const stream = events();
  const queue = events();
  let list: ReadonlyArray<ListedGame> = [
    { ...game, title: "雨", titleTranslation: "Rain", ...listed },
  ];
  const browsed: Array<string> = [];
  const moves: Array<unknown> = [];
  const inspected: Array<unknown> = [];
  serveApi(async (request) => {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/api/games":
        return Response.json(list);
      case "/api/activity":
        return stream.response();
      case "/api/activity/runs":
        return queue.response();
      case "/api/inspect": {
        const body = await request.json();
        inspected.push(body);
        if (otherVersion && !body.choice)
          return Response.json({
            otherVersion: {
              game: { ...game, title: "雨", build: { sha256: "s", version: "v0.40" } },
              titleTranslation: "Rain",
              sure: true,
              version: "v0.41",
            },
          });
        list = [moved];
        return Response.json({ game: moved, catalog: catalogOf(moved) });
      }
      case "/api/folders": {
        const asked = url.searchParams.get("path") ?? "";
        browsed.push(asked);
        return Response.json(listing(asked));
      }
      case "/api/games/move":
        moves.push(await request.json());
        list = [moved];
        return Response.json({ game: moved, catalog: catalogOf(moved) });
      case "/api/catalog/changes":
        return catalogFeed(() => catalogOf(moved)).response();
      case "/api/settings":
        return Response.json({});
    }
    return new Response(null, { status: 404 });
  });
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<RouterProvider router={createAppRouter(history)} />);
  stream.send(idle);
  queue.send([]);
  return { history, browsed, moves, inspected, queue };
};

test("a game whose run waits shows an hourglass saying what for, then a spinner once it goes", async () => {
  const { queue } = showNav();
  const harbor = { id: "a1b2c3d4e5f60718293a", title: "Harbor" };
  queue.send([
    { kind: "imageReading", game: harbor, waitingFor: [] },
    {
      kind: "translation",
      game: { id: game.id, title: "Rain" },
      waitingFor: [{ kind: "imageReading", game: harbor }],
    },
  ]);
  const waits = page.getByRole("img", { name: "Translation waits for image reading in Harbor" });
  await expect.element(waits).toBeVisible();
  await page.getByRole("button", { name: /^雨/ }).hover();
  await expect
    .element(page.getByText("Translation waits for image reading in Harbor"))
    .toBeVisible();

  queue.send([{ kind: "translation", game: { id: game.id, title: "Rain" }, waitingFor: [] }]);
  await expect.element(page.getByRole("status", { name: "Translating" })).toBeVisible();
  await expect.element(waits).not.toBeInTheDocument();
  queue.send([]);
  await expect.element(page.getByRole("status", { name: "Translating" })).not.toBeInTheDocument();
});

test("clicking a game opens its page without reading its folder again", async () => {
  const { history, inspected } = showNav();
  await page.getByRole("button", { name: "雨 MV Rain" }).click();
  await expect.poll(() => history.location.pathname).toBe(`/games/${game.id}`);
  await expect.element(page.getByRole("heading", { name: "雨", level: 1 })).toBeVisible();
  expect(inspected).toEqual([]);
});

test("a game whose folder moved can be moved to its new folder", async () => {
  const { history, moves } = showNav("/", { listed: { folderMissing: true } });
  const alert = page.getByRole("alert");
  await expect.element(alert).toBeVisible();
  expect(alert.element().textContent).toContain(`No game at ${game.root} any more.`);
  await alert.getByRole("button", { name: "Choose its new folder…" }).click();
  await page.getByRole("textbox", { name: "Folder" }).fill("/games/new");
  await page.getByRole("button", { name: "Go" }).click();
  await page.getByRole("button", { name: "rain Game" }).click();
  await page.getByRole("button", { name: "Choose this folder" }).click();
  await expect.poll(() => history.location.pathname).toBe(`/games/${game.id}`);
  expect(moves).toEqual([{ id: game.id, path: moved.root }]);
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
});

test("Open a game… opens the folder chosen in the folder browser, which starts beside the open game", async () => {
  const { history, browsed, inspected } = showNav("/settings", {
    listed: { root: "/games/old/rain" },
  });
  await page.getByRole("button", { name: "雨 MV Rain" }).click();
  await page.getByRole("button", { name: "Open a game…" }).click();
  await expect.element(page.getByRole("textbox", { name: "Folder" })).toHaveValue("/games/old");
  expect(browsed).toEqual(["/games/old/rain/.."]);
  await page.getByRole("button", { name: "Up" }).click();
  await expect.element(page.getByRole("textbox", { name: "Folder" })).toHaveValue("/games");
  await page.getByRole("textbox", { name: "Folder" }).fill(moved.root);
  await page.getByRole("button", { name: "Go" }).click();
  await expect.element(page.getByRole("textbox", { name: "Folder" })).toHaveValue(moved.root);
  await page.getByRole("button", { name: "Choose this folder" }).click();
  await expect.poll(() => inspected).toEqual([{ path: moved.root }]);
  await expect.poll(() => history.location.pathname).toBe(`/games/${game.id}`);
});

test("opening another version of a listed game asks whether to replace it first", async () => {
  const { history, inspected } = showNav("/settings", { otherVersion: true });
  const chooseFolder = async () => {
    await page.getByRole("button", { name: "Open a game…" }).click();
    await page.getByRole("textbox", { name: "Folder" }).fill(moved.root);
    await page.getByRole("button", { name: "Go" }).click();
    await page.getByRole("button", { name: "Choose this folder" }).click();
  };
  await chooseFolder();
  await expect.element(page.getByText("Another version of Rain")).toBeVisible();
  await expect
    .element(
      page.getByText(`RPGTL already has Rain (v0.40) in ${game.root}.`, {
        exact: false,
      }),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Don't open" }).click();
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  expect(history.location.pathname).toBe("/settings");

  await chooseFolder();
  await page.getByRole("button", { name: "Replace" }).click();
  await expect
    .poll(() => inspected)
    .toEqual([
      { path: moved.root },
      { path: moved.root },
      { path: moved.root, choice: { replace: game.id } },
    ]);
  await expect.poll(() => history.location.pathname).toBe(`/games/${game.id}`);
});

test("cancelling the folder browser opens nothing", async () => {
  const { inspected } = showNav(`/games/${game.id}`);
  await page.getByRole("button", { name: "Open a game…" }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(inspected).toEqual([]);
});
