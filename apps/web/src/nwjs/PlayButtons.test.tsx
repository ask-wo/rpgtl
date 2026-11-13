import type { GameActivity, GameLaunch, ProgramStatus } from "@rpgtl/contracts";
import { page } from "vite-plus/test/browser";
import { expect, test, vi } from "vite-plus/test";
import { events, render, serveApi } from "../testUtils/fakeApi.tsx";
import { PlayButtons } from "./PlayButtons.tsx";

const notReady: ProgramStatus = {
  name: "NW.js",
  version: "v0.117.0",
  size: 100e6,
  folder: "/home/player/.cache/rpgtl/nwjs",
  phase: { _tag: "Missing" },
  attempt: 0,
};

/** The status of the first download, which the download request starts. */
const downloading: ProgramStatus = { ...notReady, attempt: 1 };

/** RPGTL's server as far as Play talks to it; `requests` lists what the page asked for. */
const fakeServer = () => {
  const stream = events();
  let now: GameActivity = {
    program: notReady,
    launch: null,
    translation: null,
    images: null,
    importing: null,
  };
  /** Sends the game's activity with these parts changed. */
  const activity = (change: Partial<GameActivity>) => {
    now = { ...now, ...change };
    stream.send(now);
  };
  const requests = serveApi((request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/activity") return stream.response();
    if (pathname === "/api/launch/download")
      return Response.json({ ...downloading, phase: { _tag: "Downloading", received: 0 } });
    if (pathname === "/api/launch") {
      const started: GameLaunch = {
        phase: { _tag: "Running" },
        pid: 42,
        log: "/state/logs/nwjs.log",
        command: "nw .",
      };
      return Response.json(started);
    }
    if (pathname === "/api/launch/stop") return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  });
  return { activity, requests };
};

test("Play asks before downloading NW.js, starts the game once it is downloaded, and turns into Stop while it runs", async () => {
  const server = fakeServer();
  render(<PlayButtons gameId="0f1e2d3c4b5a69788796" inBrowser />);
  server.activity({});

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.element(page.getByText("Download NW.js?")).toBeVisible();
  await expect
    .element(page.getByText("100 MB to /home/player/.cache/rpgtl/nwjs.", { exact: false }))
    .toBeVisible();
  await page.getByRole("button", { name: "Download and play" }).click();
  server.activity({ program: { ...downloading, phase: { _tag: "Downloading", received: 40e6 } } });
  await expect.element(page.getByText("Downloading NW.js v0.117.0")).toBeVisible();
  await expect.element(page.getByText("40 of 100 MB")).toBeVisible();
  expect(server.requests).not.toContain("POST /api/launch");

  server.activity({ program: { ...downloading, phase: { _tag: "Ready" } } });
  await vi.waitFor(() => expect(server.requests).toContain("POST /api/launch"), 5000);
  server.activity({
    launch: { phase: { _tag: "Running" }, pid: 42, log: "/state/logs/nwjs.log", command: "nw ." },
  });
  await expect
    .element(page.getByText("Running in NW.js (PID 42).", { exact: false }))
    .toBeVisible();
  const play = page.getByRole("button", { name: "Play", exact: true });
  await expect.element(play).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Stop" }).click();
  await vi.waitFor(() => expect(server.requests).toContain("POST /api/launch/stop"), 5000);
  server.activity({
    launch: {
      phase: { _tag: "Stopped" },
      pid: 42,
      log: "/state/logs/nwjs.log",
      command: "nw .",
    },
  });
  await expect.element(page.getByText("NW.js was stopped.", { exact: false })).toBeVisible();
  await expect.element(play).toBeEnabled();
});

test("Not now leaves NW.js undownloaded", async () => {
  const server = fakeServer();
  render(<PlayButtons gameId="0f1e2d3c4b5a69788796" inBrowser />);
  server.activity({});

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect.element(page.getByText("Download NW.js?")).not.toBeInTheDocument();
  expect(server.requests).not.toContain("POST /api/launch/download");
});

test("a download that fails before the page sees it says why, and a later download doesn't start the game", async () => {
  const server = fakeServer();
  render(<PlayButtons gameId="0f1e2d3c4b5a69788796" inBrowser />);
  server.activity({});

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.getByRole("button", { name: "Download and play" }).click();
  await vi.waitFor(() => expect(server.requests).toContain("POST /api/launch/download"));
  server.activity({
    program: { ...downloading, phase: { _tag: "Missing", error: "Offline" } },
  });
  await expect.element(page.getByText("NW.js didn't download: Offline")).toBeVisible();

  server.activity({ program: { ...notReady, attempt: 2, phase: { _tag: "Ready" } } });
  await expect.element(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(server.requests).not.toContain("POST /api/launch");
});

test("a long log path wraps instead of widening the page", async () => {
  const server = fakeServer();
  const frame = document.body.appendChild(document.createElement("div"));
  frame.style.width = "400px";
  const folder = `C:\\Users\\Player\\AppData\\Local\\rpgtl\\data\\games\\0f1e2d3c4b5a69788796`;
  render(<PlayButtons gameId="0f1e2d3c4b5a69788796" inBrowser />, frame);
  server.activity({
    program: { ...notReady, phase: { _tag: "Ready" } },
    launch: {
      phase: { _tag: "Exited", exitCode: 0 },
      pid: 42,
      log: `${folder}\\logs\\nwjs.log`,
      command: `& '${folder}\\nw.exe' '--log-file=${folder}\\logs\\nwjs.log'`,
    },
  });
  await expect
    .element(page.getByText("NW.js exited with exit code 0.", { exact: false }))
    .toBeVisible();
  expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
});

test("Play is off where the game's program can't run", async () => {
  const server = fakeServer();
  render(<PlayButtons gameId="0f1e2d3c4b5a69788796" inBrowser={false} />);
  server.activity({ program: { ...notReady, name: "mkxp-z", phase: { _tag: "Unsupported" } } });

  await expect.element(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled();
});
