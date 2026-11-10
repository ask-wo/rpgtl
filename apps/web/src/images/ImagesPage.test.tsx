import type {
  Catalog,
  Entry,
  GameActivity,
  ImageReaderSetupStatus,
  ImageReadResults,
  ImageResult,
} from "@rpgtl/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { beforeAll, expect, test, vi } from "vite-plus/test";
import { GameContext } from "../games/GameContext.ts";
import { catalogFeed, events, render, serveApi } from "../testUtils/fakeApi.tsx";
import { game, idle } from "../testUtils/game.ts";
import { ImagesPage } from "./ImagesPage.tsx";

beforeAll(() => page.viewport(1280, 800));

const text = (id: string, file: string, line: number, source: string, translation: string) =>
  ({
    id,
    file,
    path: ["lines", String(line)],
    source,
    translation: translation ? { guess: { value: translation, run: "r" } } : {},
  }) satisfies Entry;

const saved: Catalog = {
  version: 1,
  game: { id: game.id, title: game.title, engine: "MV" },
  entries: [
    text("a", "img/pictures/Title", 0, "开始", "Start"),
    text("b", "img/pictures/Title", 1, "继续", ""),
    {
      ...text("c", "img/system/Menu", 0, "物品", "Items"),
      translation: { guess: { value: "Items", run: "r", long: "Inventory" } },
    },
    { ...text("m", "Map001.json", 0, "你好", "Hello"), path: ["events", "1"] },
  ],
  glossary: [],
  translate: true,
};

const read = (file: string): ImageResult => ({
  file,
  sha256: "0".repeat(64),
  width: 16,
  height: 16,
  lines: [],
});
const results: ImageReadResults = {
  version: 1,
  images: {
    "img/pictures/Title": read("img/pictures/Title.png"),
    "img/system/Menu": read("img/system/Menu.png"),
    "img/pictures/Empty": read("img/pictures/Empty.png"),
  },
};

/** RPGTL's server with the game's catalog and read images; `posts` lists each change's body. */
const fakeServer = () => {
  const stream = events();
  const readerStream = events();
  const server = {
    catalog: saved,
    activity: (now: GameActivity) => stream.send(now),
    reader: (now: ImageReaderSetupStatus) => readerStream.send(now),
    posts: [] as Array<{ readonly path: string; readonly body: unknown }>,
    requests: [] as Array<string>,
    feed: catalogFeed((): Catalog => server.catalog),
  };
  server.requests = serveApi(async (request) => {
    const path = new URL(request.url).pathname;
    switch (path) {
      case "/api/activity":
        return stream.response();
      case "/api/image-reader":
        return readerStream.response();
      case "/api/settings":
        return Response.json({});
      case "/api/images/read":
        server.posts.push({ path, body: await request.json() });
        return Response.json({
          phase: { _tag: "Running" },
          total: 1,
          done: 0,
          entries: 3,
          failed: [],
          warnings: [],
        });
      case "/api/catalog/changes":
        return server.feed.response();
      case "/api/images":
        return Response.json(results);
      case "/api/entries":
      case "/api/catalog/images":
        server.posts.push({ path, body: await request.json() });
        return new Response(null, { status: 204 });
      case "/api/images/clear":
        server.posts.push({ path, body: await request.json() });
        server.catalog = {
          ...server.catalog,
          entries: server.catalog.entries.filter((entry) => !entry.file.startsWith("img/")),
        };
        server.feed.changed();
        return Response.json(server.catalog);
    }
    return new Response(null, { status: 404 });
  });
  return server;
};

const showImages = () =>
  render(
    <GameContext value={game}>
      <div className="flex h-svh flex-col">
        <ImagesPage />
      </div>
    </GameContext>,
  );

const grid = () => page.getByRole("region", { name: "Images" });

test("lists the images with text, and the filter and search narrow them", async () => {
  const server = fakeServer();
  showImages();
  server.activity(idle);
  await expect
    .element(grid().getByRole("button", { name: "Open img/pictures/Title" }))
    .toBeVisible();
  await expect.element(grid().getByText("1 of 2 translated")).toBeVisible();
  await expect.element(grid().getByText("1 of 1 translated")).toBeVisible();
  await expect.element(grid().getByText("Empty")).not.toBeInTheDocument();

  await page.getByRole("button", { name: "With untranslated text 1" }).click();
  await expect
    .element(grid().getByRole("button", { name: "Open img/system/Menu" }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: /^All/ }).click();
  await page.getByRole("searchbox", { name: "Search the images" }).fill("items");
  await expect.element(grid().getByRole("button", { name: "Open img/system/Menu" })).toBeVisible();
  await expect
    .element(grid().getByRole("button", { name: "Open img/pictures/Title" }))
    .not.toBeInTheDocument();
});

test("the editor saves each text's English and artwork, and the whole image kept", async () => {
  const server = fakeServer();
  showImages();
  server.activity(idle);
  await grid().getByRole("button", { name: "Open img/pictures/Title" }).click();
  const editor = page.getByRole("dialog");
  await expect.element(editor.getByText("1 of 2")).toBeVisible();

  await editor.getByRole("textbox", { name: "English for 继续" }).fill("Continue");
  await editor.getByRole("checkbox", { name: "Keep original artwork" }).first().click();
  // Typed English saves once typing pauses, which on a slow machine comes before the click.
  await vi.waitFor(() =>
    expect(
      server.posts.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ).toEqual([
      { path: "/api/entries", body: { id: game.id, entries: [{ id: "a", keepOriginal: true }] } },
      {
        path: "/api/entries",
        body: { id: game.id, entries: [{ id: "b", translation: "Continue" }] },
      },
    ]),
  );
  await editor.getByRole("checkbox", { name: "Show this image unchanged" }).click();
  await vi.waitFor(() =>
    expect(server.posts.at(-1)).toEqual({
      path: "/api/catalog/images",
      body: { id: game.id, unchangedImages: ["img/pictures/Title"] },
    }),
  );
  // The saves don't read every image's read results again.
  expect(server.requests.filter((asked) => asked === "GET /api/images")).toHaveLength(1);

  // Alt+→ opens the next image, whose shorter answer can be swapped for the first one.
  await editor.getByRole("textbox", { name: "English for 开始" }).click();
  await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
  await expect.element(editor.getByText("2 of 2")).toBeVisible();
  await expect.element(editor.getByText("Inventory")).toBeVisible();
  await editor.getByRole("button", { name: "Use" }).click();
  await expect
    .element(editor.getByRole("textbox", { name: "English for 物品" }))
    .toHaveValue("Inventory");
});

test("a misread text can be corrected, which clears the run's English, and the text read restores it", async () => {
  const server = fakeServer();
  showImages();
  server.activity(idle);
  await grid().getByRole("button", { name: "Open img/pictures/Title" }).click();
  const editor = page.getByRole("dialog");
  await editor.getByRole("button", { name: "Correct 开始" }).click();
  await editor.getByRole("textbox", { name: "Text in the image for 开始" }).fill("开始游戏");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect
    .element(editor.getByRole("textbox", { name: "English for 开始游戏" }))
    .toHaveValue("");
  await vi.waitFor(() =>
    expect(server.posts).toEqual([
      { path: "/api/entries", body: { id: game.id, entries: [{ id: "a", text: "开始游戏" }] } },
    ]),
  );

  server.catalog = {
    ...saved,
    entries: saved.entries.map((entry) =>
      entry.id === "a"
        ? { ...entry, source: "开始游戏", readerText: "开始", translation: {} }
        : entry,
    ),
  };
  server.feed.changed();
  await expect.element(editor.getByText("You corrected it.", { exact: false })).toBeVisible();
  await editor.getByRole("button", { name: "Use it" }).click();
  await vi.waitFor(() =>
    expect(server.posts.at(-1)).toEqual({
      path: "/api/entries",
      body: { id: game.id, entries: [{ id: "a", text: "开始" }] },
    }),
  );
});

test("Read again in the editor reads its image from scratch once the reader is ready", async () => {
  const server = fakeServer();
  showImages();
  server.activity(idle);
  await grid().getByRole("button", { name: "Open img/pictures/Title" }).click();
  const readAgain = page.getByRole("dialog").getByRole("button", { name: "Read again" });
  await expect.element(readAgain).toBeDisabled();
  const ready: ImageReaderSetupStatus = {
    device: "gpu",
    download: 0,
    folder: "/home/player/.cache/rpgtl/image-reader",
    ready: true,
    onDisk: true,
    korean: { ready: false, download: 14e6 },
    phase: { _tag: "Idle" },
    attempt: 0,
  };
  server.reader(ready);
  await expect.element(readAgain).toBeEnabled();
  server.reader({ ...ready, phase: { _tag: "Removing" } });
  await expect.element(readAgain).toBeDisabled();
  server.reader({ ...ready, phase: { _tag: "SettingUp", step: "cleanup", parts: [] } });
  await expect.element(readAgain).toBeDisabled();
  const outside = { ...ready, ready: false, external: "http://127.0.0.1:8910" };
  server.reader(outside);
  await expect.element(readAgain).toBeEnabled();
  server.reader({ ...outside, phase: { _tag: "SettingUp", step: "uv", parts: [] } });
  await expect.element(readAgain).toBeDisabled();
  server.reader(ready);
  await readAgain.click();
  await vi.waitFor(() =>
    expect(server.posts).toEqual([
      {
        path: "/api/images/read",
        body: {
          id: game.id,
          again: ["img/pictures/Title"],
        },
      },
    ]),
  );
});

test("an open image that loses its text closes the editor, which stays closed when the text comes back", async () => {
  const server = fakeServer();
  showImages();
  server.activity(idle);
  await grid().getByRole("button", { name: "Open img/pictures/Title" }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  const withTitle = server.catalog;
  server.catalog = {
    ...withTitle,
    entries: withTitle.entries.filter((entry) => entry.file !== "img/pictures/Title"),
  };
  server.feed.changed();
  await vi.waitFor(() => expect(page.getByRole("dialog").query()).toBeNull());
  server.catalog = withTitle;
  server.feed.changed();
  await expect
    .element(grid().getByRole("button", { name: "Open img/pictures/Title" }))
    .toBeVisible();
  expect(page.getByRole("dialog").query()).toBeNull();
});

test("the lettering saves as it is chosen, and Clear image text asks first", async () => {
  const server = fakeServer();
  showImages();
  server.activity(idle);
  await expect.element(page.getByText("Start · Items", { exact: true }).first()).toBeVisible();
  await page.getByRole("combobox", { name: "English lettering weight" }).click();
  await page.getByRole("option", { name: "Always bold" }).click();
  await vi.waitFor(() =>
    expect(server.posts).toEqual([
      { path: "/api/catalog/images", body: { id: game.id, imageBold: "always", imageFont: null } },
    ]),
  );

  await page.getByRole("button", { name: "Clear image text…" }).click();
  await page.getByRole("button", { name: "Clear image text" }).click();
  await expect.element(page.getByText(/^Cleared the image text/)).toBeVisible();
  expect(server.posts.at(-1)).toEqual({ path: "/api/images/clear", body: { id: game.id } });
  await expect.element(page.getByText(/^No images with text yet/)).toBeVisible();
});

test("a run locks the image texts", async () => {
  const server = fakeServer();
  showImages();
  server.activity(idle);
  await page.getByRole("button", { name: "Clear image text…" }).click();
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
  server.activity({
    ...idle,
    images: {
      phase: { _tag: "Running" },
      total: 3,
      done: 1,
      entries: 3,
      failed: [],
      warnings: [],
    },
  });
  await expect.element(page.getByRole("button", { name: "Clear image text…" })).toBeDisabled();
  await vi.waitFor(() => expect(page.getByRole("alertdialog").query()).toBeNull());
  expect(document.querySelector("#lettering-weight")?.closest("[inert]")).not.toBeNull();
  await grid().getByRole("button", { name: "Open img/pictures/Title" }).click();
  await expect.element(page.getByRole("textbox", { name: "English for 继续" })).toBeDisabled();
});
