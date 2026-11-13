import type {
  Catalog,
  Entry,
  GameActivity,
  ImageReaderSetupStatus,
  ImageRunStatus,
  Location,
  RunStatus,
} from "@rpgtl/contracts";
import { useState } from "react";
import { page } from "vite-plus/test/browser";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { GameContext } from "../games/GameContext.ts";
import { catalogFeed, events, render, serveApi } from "../testUtils/fakeApi.tsx";
import { game, idle } from "../testUtils/game.ts";
import { RunBar } from "./RunBar.tsx";
import { TranslationCard } from "./TranslationCard.tsx";

const entry = (id: string, location: Location, translation: string): Entry => ({
  id,
  location,
  source: "你好",
  translation: translation ? { user: translation } : {},
});
const text = (id: string, translation: string) =>
  entry(id, { _tag: "SystemText", keys: [id] }, translation);
const imageText = (id: string, file: string, translation: string) =>
  entry(id, { _tag: "ImageLines", image: file, lines: [0] }, translation);

const notSetUp: ImageReaderSetupStatus = {
  device: "gpu",
  download: 2.7e9,
  folder: "/home/player/.cache/rpgtl/image-reader",
  ready: false,
  onDisk: false,
  korean: { ready: false, download: 14e6 },
  phase: { _tag: "Idle" },
  attempt: 0,
};

/** The status of the first setup, which the setup request starts. */
const settingUp: ImageReaderSetupStatus = { ...notSetUp, attempt: 1 };

const allParts = [
  "textDetection",
  "textRecognition",
  "lamaDownload",
  "lamaCheck",
  "lamaExport",
] as const;

const running: RunStatus = {
  kind: "translate",
  phase: { _tag: "Running" },
  total: 2,
  done: 0,
  pass: "text",
  names: { total: 0, done: 0, failed: 0 },
  translated: 1,
  failed: [],
  left: 2,
  warnings: [],
};

/**
 * RPGTL's server with one game's catalog, Claude as the chosen translator and the game's
 * activity, which the test sends; `started` lists the payloads of the runs the page started.
 */
const fakeServer = (saved: Catalog) => {
  const stream = events();
  const readerStream = events();
  const server = {
    catalog: saved,
    activity: (now: GameActivity) => stream.send(now),
    reader: (now: ImageReaderSetupStatus) => readerStream.send(now),
    started: [] as Array<unknown>,
    setups: [] as Array<unknown>,
    requests: [] as Array<string>,
    feed: catalogFeed((): Catalog => server.catalog),
  };
  server.requests = serveApi(async (request) => {
    const { pathname } = new URL(request.url);
    switch (pathname) {
      case "/api/activity":
        return stream.response();
      case "/api/image-reader":
        return readerStream.response();
      case "/api/image-reader/setup":
        server.setups.push(await request.json());
        return Response.json({
          ...settingUp,
          phase: { _tag: "SettingUp", step: "uv", parts: [] },
        });
      case "/api/catalog/changes":
        return server.feed.response();
      case "/api/settings":
        return Response.json({ translation: { translator: "claude" } });
      case "/api/images/export":
        return Response.json(null);
      case "/api/translate":
        server.started.push(await request.json());
        return Response.json(running);
      case "/api/images/read/stop":
        return Response.json(null);
      case "/api/images":
        return Response.json({
          version: 1,
          images: Object.fromEntries(
            ["img/pictures/Title", "img/pictures/Blank"].map((image) => [
              image,
              { file: `${image}.png`, sha256: "0".repeat(64), width: 1, height: 1, lines: [] },
            ]),
          ),
        });
      case "/api/images/read":
        server.started.push(await request.json());
        return Response.json({
          running: true,
          stopped: false,
          total: 0,
          done: 0,
          entries: 1,
          failed: [],
          warnings: [],
        });
    }
    return new Response(null, { status: 404 });
  });
  return server;
};

const translating = (entries: Catalog["entries"]): Catalog => ({
  version: 1,
  game: { id: game.id, title: game.title, engine: "MV" },
  entries,
  glossary: [],
  translate: true,
});

const showGame = (fits: RunStatus["kind"] | "read-images" = "translate", onShowFailed = () => {}) =>
  render(
    <GameContext value={game}>
      <RunBar fits={fits} onShowFailed={onShowFailed} />
      <TranslationCard />
    </GameContext>,
  );

test("Translate starts a run, and the counts grow while it saves", async () => {
  const server = fakeServer(
    translating([text("a", "Hello"), text("b", ""), imageText("c", "img/pictures/Title", "")]),
  );
  const showFailed = vi.fn();
  showGame("translate", showFailed);
  server.activity(idle);
  const bar = page.getByRole("region", { name: "Runs" });
  await expect
    .element(
      bar.getByText(
        "1 of 2 text entries translated · 1 missing · 0 of 1 entry in images translated",
      ),
    )
    .toBeVisible();

  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await vi.waitFor(() => expect(server.started).toHaveLength(1));
  expect(server.started[0]).toEqual({ id: game.id, kind: "translate" });

  server.activity({
    ...idle,
    translation: { ...running, total: 5, pass: "names", names: { total: 3, done: 1, failed: 0 } },
  });
  await expect.element(bar.getByText("Translating names · 1 of 3 names translated")).toBeVisible();
  server.activity({ ...idle, translation: running });
  await expect.element(bar.getByText("Translating text · 0 of 2 entries translated")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect.element(page.getByRole("switch")).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Import…" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Clear all…" })).toBeDisabled();
  await expect
    .element(page.getByText("A run is going: stop it to change these settings."))
    .toBeVisible();

  server.catalog = translating([
    text("a", "Hello"),
    text("b", "Rain"),
    imageText("c", "img/pictures/Title", ""),
  ]);
  server.feed.changed();
  server.activity({ ...idle, translation: { ...running, done: 1, translated: 2, left: 1 } });
  await expect.element(page.getByText("2 of 2 text entries translated")).toBeVisible();

  server.activity({
    ...idle,
    translation: {
      ...running,
      phase: { _tag: "Finished" },
      done: 1,
      translated: 2,
      failed: ["b", "c"],
      left: 0,
      warnings: ["The glossary model answered in Chinese once."],
    },
  });
  await expect
    .element(bar.getByText("Translation done: 1 entry translated and saved."))
    .toBeVisible();
  await expect
    .element(bar.getByText("2 entries couldn't be translated; Translate tries them again."))
    .toBeVisible();
  // The entry in an image is on the Images page.
  await bar.getByRole("button", { name: "Show the 1 failed text entry" }).click();
  expect(showFailed).toHaveBeenCalledOnce();
  await expect.element(bar.getByText("The glossary model answered in Chinese once.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Import…" })).toBeEnabled();
});

test("on the Glossary page the bar offers Build glossary, and says how building it goes", async () => {
  const server = fakeServer({
    ...translating([text("a", ""), text("b", "")]),
    glossary: [{ source: "雨", translation: { user: "Rain" }, kind: { guess: { value: "name" } } }],
  });
  showGame("build-glossary");
  server.activity(idle);
  const bar = page.getByRole("region", { name: "Runs" });
  await expect
    .element(bar.getByText("0 of 2 text entries translated · 2 missing · 1 glossary term"))
    .toBeVisible();

  await page.getByRole("button", { name: "Build glossary" }).click();
  await vi.waitFor(() => expect(server.started).toHaveLength(1));
  expect(server.started[0]).toMatchObject({ kind: "build-glossary" });

  const building: RunStatus = {
    ...running,
    kind: "build-glossary",
    pass: "names",
    names: { total: 2, done: 0, failed: 0 },
  };
  server.activity({ ...idle, translation: building });
  await expect
    .element(bar.getByText("Building the glossary · 0 of 2 names translated"))
    .toBeVisible();
  server.activity({
    ...idle,
    translation: { ...building, phase: { _tag: "Finished" }, done: 2, left: 0 },
  });
  await expect
    .element(bar.getByText("Glossary built: 2 names translated and saved.", { exact: false }))
    .toBeVisible();
});

test("a step such as loading the model shows with a spinner until translating starts", async () => {
  const server = fakeServer(translating([text("a", "")]));
  showGame();
  server.activity({
    ...idle,
    translation: { ...running, phase: { _tag: "Running", step: "Loading the model" } },
  });
  const bar = page.getByRole("region", { name: "Runs" });
  await expect.element(bar.getByText("Loading the model")).toBeVisible();
  await expect.element(bar.getByRole("status", { name: "Loading" })).toBeVisible();
  server.activity({ ...idle, translation: running });
  await expect.element(bar.getByText("Translating text")).toBeVisible();
  expect(bar.getByRole("status", { name: "Loading" }).query()).toBeNull();
});

test("a waiting run names what it waits for, can be stopped, and leaves the game editable", async () => {
  const server = fakeServer(translating([text("a", "")]));
  showGame();
  const harbor = { id: "harbor", title: "Harbor Tales" };
  server.activity({
    ...idle,
    translation: {
      ...running,
      phase: {
        _tag: "Waiting",
        for: [
          { kind: "translation", game: harbor },
          { kind: "imageReading", game: { id: game.id, title: game.title } },
        ],
      },
    },
  });
  const bar = page.getByRole("region", { name: "Runs" });
  await expect
    .element(
      bar.getByText(
        "It starts once translation in Harbor Tales and this game's image reading have finished.",
        { exact: false },
      ),
    )
    .toBeVisible();
  await expect.element(bar.getByRole("button", { name: "Stop" })).toBeEnabled();
  await expect.element(page.getByRole("switch")).toBeEnabled();
});

test("a run whose work is over says it is ending, without Stop, until it has ended", async () => {
  const server = fakeServer(translating([text("a", "")]));
  showGame();
  server.activity({ ...idle, translation: { ...running, phase: { _tag: "Ending" } } });
  const bar = page.getByRole("region", { name: "Runs" });
  await expect.element(bar.getByText("Ending the run")).toBeVisible();
  await expect.element(bar.getByRole("button", { name: "Stop" })).toBeDisabled();
  server.activity({ ...idle, translation: { ...running, phase: { _tag: "Stopped" } } });
  await expect.element(bar.getByText("Translation stopped.", { exact: false })).toBeVisible();
  expect(bar.getByRole("button", { name: "Stop" }).query()).toBeNull();
});

test("a run says how long the rest takes once it has gone on for a while", async () => {
  const server = fakeServer(translating([text("a", "")]));
  showGame();
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const start = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(start);
  server.activity({ ...idle, translation: { ...running, total: 1000 } });
  const bar = page.getByRole("region", { name: "Runs" });
  await expect.element(bar.getByText(/0 of 1,000 entries translated/)).toBeVisible();
  vi.spyOn(Date, "now").mockReturnValue(start + 2 * 60_000);
  server.activity({ ...idle, translation: { ...running, total: 1000, done: 100 } });
  await expect.element(bar.getByText(/about 18 min left/)).toBeVisible();
});

test("image reading says it checks the images, then which reader loads", async () => {
  const server = fakeServer(translating([text("a", "")]));
  showGame();
  const images: ImageRunStatus = {
    phase: { _tag: "Running" },
    total: 0,
    done: 0,
    entries: 0,
    failed: [],
    warnings: [],
  };
  server.activity({ ...idle, images });
  const bar = page.getByRole("region", { name: "Runs" });
  await expect.element(bar.getByText("Checking which images are new or changed")).toBeVisible();
  server.activity({ ...idle, images: { ...images, total: 3 } });
  await expect.element(bar.getByText("Reading images · 0 of 3")).toBeVisible();
  server.activity({
    ...idle,
    images: { ...images, total: 3, phase: { _tag: "Running", loading: "imageReader" } },
  });
  await expect.element(bar.getByText("Loading the image reader")).toBeVisible();
  server.activity({
    ...idle,
    images: {
      ...images,
      total: 3,
      phase: { _tag: "Running", loading: "backupReader", fallback: { done: 0, total: 1 } },
    },
  });
  await expect.element(bar.getByText("Loading the backup reader's model")).toBeVisible();
});

test("image reading shows on the bar, and Stop asks to stop it", async () => {
  const server = fakeServer(translating([text("a", "")]));
  showGame();
  server.activity({
    ...idle,
    images: {
      phase: {
        _tag: "Running",
        fallback: { done: 1, total: 3, waiting: "Waiting for 6 GB of free memory." },
      },
      total: 10,
      done: 10,
      entries: 4,
      failed: [],
      warnings: [],
    },
  });
  const bar = page.getByRole("region", { name: "Runs" });
  await expect
    .element(
      bar.getByText(
        "Reading partly read images again · 1 of 3 with the backup reader · Waiting for 6 GB of free memory.",
      ),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await vi.waitFor(() => expect(server.requests).toContain("POST /api/images/read/stop"));
});

test("the bar is hidden while the game's translation is off", async () => {
  const server = fakeServer({ ...translating([text("a", "")]), translate: false });
  showGame();
  server.activity(idle);
  await expect.element(page.getByText("Switch on to translate or import.")).toBeVisible();
  await expect.element(page.getByRole("region", { name: "Runs" })).not.toBeInTheDocument();
});

test("on the Images page the bar reads new images, or all again", async () => {
  const server = fakeServer(
    translating([text("a", "Hello"), imageText("c", "img/pictures/Title", "")]),
  );
  showGame("read-images");
  server.activity(idle);
  server.reader({ ...notSetUp, ready: true });
  const bar = page.getByRole("region", { name: "Runs" });
  await expect
    .element(bar.getByText("2 images read · 1 with text · 0 of 1 entry in images translated"))
    .toBeVisible();
  await bar.getByRole("button", { name: "Read new images" }).click();
  await vi.waitFor(() => expect(server.started).toEqual([{ id: game.id }]));
  await bar.getByRole("button", { name: "Read all again" }).click();
  await vi.waitFor(() =>
    expect(server.started).toEqual([{ id: game.id }, { id: game.id, again: "all" }]),
  );
});

test("Read new images asks to set the reader up first, and reads once it is set up", async () => {
  const server = fakeServer(translating([imageText("c", "img/pictures/Title", "")]));
  showGame("read-images");
  server.activity(idle);
  server.reader(notSetUp);
  const bar = page.getByRole("region", { name: "Runs" });

  await bar.getByRole("button", { name: "Read new images" }).click();
  await expect.element(page.getByText("Set up the image reader?")).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();
  expect(server.requests).not.toContain("POST /api/image-reader/setup");

  await bar.getByRole("button", { name: "Read new images" }).click();
  await expect
    .element(
      page.getByText("download of about 2.7 GB to /home/player/.cache/rpgtl/image-reader.", {
        exact: false,
      }),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Set up and read" }).click();
  await vi.waitFor(() => expect(server.requests).toContain("POST /api/image-reader/setup"));
  server.reader({
    ...notSetUp,
    phase: {
      _tag: "SettingUp",
      step: "packages",
      downloading: { done: 600e6, total: 2.4e9 },
      parts: [],
    },
  });
  await expect
    .element(
      bar.getByText("Downloading the reader's Python packages · 600 of 2,400 MB", {
        exact: false,
      }),
    )
    .toBeVisible();
  await expect
    .element(bar.getByRole("progressbar", { name: "Image reader setup" }))
    .toHaveAttribute("aria-valuenow", "25");
  server.reader({ ...settingUp, phase: { _tag: "SettingUp", step: "models", parts: [] } });
  await expect.element(bar.getByText("then reading starts", { exact: false })).toBeVisible();
  expect(server.started).toEqual([]);

  server.reader({ ...settingUp, ready: true });
  await vi.waitFor(() => expect(server.started).toHaveLength(1), 5000);
});

test("a failed setup shows why in the bar and reads nothing", async () => {
  const server = fakeServer(translating([imageText("c", "img/pictures/Title", "")]));
  showGame("read-images");
  server.activity(idle);
  server.reader(notSetUp);
  const bar = page.getByRole("region", { name: "Runs" });

  await bar.getByRole("button", { name: "Read new images" }).click();
  await page.getByRole("button", { name: "Set up and read" }).click();
  await vi.waitFor(() => expect(server.requests).toContain("POST /api/image-reader/setup"));
  server.reader({ ...settingUp, phase: { _tag: "SettingUp", step: "packages", parts: [] } });
  server.reader({
    ...notSetUp,
    phase: { _tag: "SettingUp", step: "models", parts: allParts, part: "textDetection" },
  });
  await expect.element(bar.getByText("1 of 5", { exact: false })).toBeVisible();
  server.reader({
    ...notSetUp,
    phase: { _tag: "Idle", error: "Converting the image reader's models failed" },
  });
  await expect
    .element(
      bar.getByText(
        "Setting up the image reader failed: Converting the image reader's models failed",
      ),
    )
    .toBeVisible();
  expect(server.started).toEqual([]);
});

test("a setup that fails before the bar sees it says why, and a later setup doesn't start reading", async () => {
  const server = fakeServer(translating([imageText("c", "img/pictures/Title", "")]));
  showGame("read-images");
  server.activity(idle);
  server.reader(notSetUp);
  const bar = page.getByRole("region", { name: "Runs" });

  await bar.getByRole("button", { name: "Read new images" }).click();
  await page.getByRole("button", { name: "Set up and read" }).click();
  await vi.waitFor(() => expect(server.requests).toContain("POST /api/image-reader/setup"));
  server.reader({ ...settingUp, phase: { _tag: "Idle", error: "No space left" } });
  await expect
    .element(bar.getByText("Setting up the image reader failed: No space left"))
    .toBeVisible();

  server.reader({ ...settingUp, attempt: 2, ready: true });
  await expect.element(bar.getByRole("button", { name: "Read all again" })).toBeEnabled();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(server.started).toEqual([]);
});

test("the Images bar shows why the last setup failed, also when it was started elsewhere", async () => {
  const server = fakeServer(translating([imageText("c", "img/pictures/Title", "")]));
  showGame("read-images");
  server.activity(idle);
  server.reader({
    ...notSetUp,
    phase: { _tag: "Idle", error: "Converting the image reader's models failed" },
  });
  await expect
    .element(
      page.getByText(
        "Setting up the image reader failed: Converting the image reader's models failed",
      ),
    )
    .toBeVisible();
});

/** The run bar on the Images page, with a button that moves to the Glossary page. */
function Pages() {
  const [fits, setFits] = useState<RunStatus["kind"] | "read-images">("read-images");
  return (
    <GameContext value={game}>
      <button onClick={() => setFits("build-glossary")}>Glossary page</button>
      <RunBar fits={fits} onShowFailed={() => {}} />
    </GameContext>
  );
}

test("every page's bar shows the reader's setup, and reading starts after it from any page", async () => {
  const server = fakeServer(translating([imageText("c", "img/pictures/Title", "")]));
  render(<Pages />);
  server.activity(idle);
  server.reader(notSetUp);
  const bar = page.getByRole("region", { name: "Runs" });

  await bar.getByRole("button", { name: "Read new images" }).click();
  await page.getByRole("button", { name: "Set up and read" }).click();
  await vi.waitFor(() => expect(server.requests).toContain("POST /api/image-reader/setup"));
  await page.getByRole("button", { name: "Glossary page" }).click();
  server.reader({ ...settingUp, phase: { _tag: "SettingUp", step: "models", parts: [] } });
  await expect.element(bar.getByRole("button", { name: "Build glossary" })).toBeVisible();
  await expect
    .element(
      bar.getByText("Converting the reader's models · takes a few minutes, then reading starts", {
        exact: false,
      }),
    )
    .toBeVisible();
  await expect
    .element(bar.getByRole("progressbar", { name: "Image reader setup" }))
    .toHaveAttribute("aria-valuenow", "0");
  await expect
    .element(bar.getByText("text entries translated", { exact: false }))
    .not.toBeInTheDocument();

  server.reader({ ...settingUp, ready: true });
  await vi.waitFor(() => expect(server.started).toHaveLength(1), 5000);
});

test("a reader started outside RPGTL reads without setting up", async () => {
  const server = fakeServer(translating([imageText("c", "img/pictures/Title", "")]));
  showGame("read-images");
  server.activity(idle);
  server.reader({ ...notSetUp, external: "http://127.0.0.1:5001" });
  await page
    .getByRole("region", { name: "Runs" })
    .getByRole("button", { name: "Read new images" })
    .click();
  await vi.waitFor(() => expect(server.started).toHaveLength(1));
});

const koreanEntry = { ...imageText("c", "img/pictures/Title", ""), source: "모험을 시작하자" };

test("a Korean game's Read new images asks to add the Korean model, and reads once it is added", async () => {
  const server = fakeServer(translating([koreanEntry]));
  showGame("read-images");
  server.activity(idle);
  const ready = {
    ...notSetUp,
    ready: true,
    onDisk: true,
    korean: { ready: false, download: 355e6 },
  };
  server.reader(ready);
  const bar = page.getByRole("region", { name: "Runs" });

  await bar.getByRole("button", { name: "Read new images" }).click();
  await expect.element(page.getByText("Add the Korean text model?")).toBeVisible();
  await expect
    .element(page.getByText("a one-time download of about 355 MB", { exact: false }))
    .toBeVisible();
  await page.getByRole("button", { name: "Add and read" }).click();
  await vi.waitFor(() => expect(server.setups).toEqual([{ korean: true }]));
  server.reader({
    ...ready,
    phase: {
      _tag: "SettingUp",
      step: "models",
      parts: ["koreanRecognition"],
      part: "koreanRecognition",
    },
  });
  await expect
    .element(
      bar.getByText("1 of 1: downloading and converting the model that reads Korean", {
        exact: false,
      }),
    )
    .toBeVisible();
  await expect.element(bar.getByText("Adding the Korean text model")).toBeVisible();
  expect(server.started).toEqual([]);

  server.reader({ ...ready, attempt: 1, korean: { ready: true, download: 355e6 } });
  await vi.waitFor(() => expect(server.started).toHaveLength(1), 5000);
});

/** The run bar of one game, with a button that opens another game, Harbor, as the sidebar does. */
const harbor = { ...game, id: "a1b2c3d4e5f60718293a", title: "Harbor" };
function Switching() {
  const [shown, setShown] = useState(game);
  return (
    <GameContext value={shown}>
      <button onClick={() => setShown(harbor)}>Open Harbor</button>
      <RunBar fits="read-images" onShowFailed={() => {}} />
    </GameContext>
  );
}

test("a setup asked for in one game doesn't start reading in the game opened next", async () => {
  const server = fakeServer(translating([koreanEntry]));
  render(<Switching />);
  server.activity(idle);
  const ready = { ...notSetUp, ready: true, onDisk: true };
  server.reader(ready);

  await page
    .getByRole("region", { name: "Runs" })
    .getByRole("button", { name: "Read new images" })
    .click();
  await page.getByRole("button", { name: "Add and read" }).click();
  await vi.waitFor(() => expect(server.setups).toEqual([{ korean: true }]));
  server.catalog = {
    ...translating([imageText("c", "img/pictures/Title", "")]),
    game: { id: harbor.id, title: harbor.title, engine: "MV" },
  };
  await page.getByRole("button", { name: "Open Harbor" }).click();
  await expect
    .element(
      page.getByRole("region", { name: "Runs" }).getByRole("button", { name: "Read new images" }),
    )
    .toBeVisible();
  server.reader({ ...ready, attempt: 1, korean: { ready: true, download: 355e6 } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(server.started).toEqual([]);
});

test("a Korean game sets the reader up with its Korean model", async () => {
  const server = fakeServer(translating([koreanEntry]));
  showGame("read-images");
  server.activity(idle);
  server.reader(notSetUp);
  await page
    .getByRole("region", { name: "Runs" })
    .getByRole("button", { name: "Read new images" })
    .click();
  await expect
    .element(
      page.getByText("with its model for Korean, as this game is in Korean", { exact: false }),
    )
    .toBeVisible();
  await expect.element(page.getByText("download of about 2.7 GB", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Set up and read" }).click();
  await vi.waitFor(() => expect(server.setups).toEqual([{ korean: true }]));
});
