import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test as base, expect, type Page } from "@playwright/test";
import { fixture } from "../packages/game/src/testUtils/fixture.ts";
import { mvGame } from "../packages/game/src/testUtils/mvGame.ts";
import type { Entry } from "../packages/contracts/src/catalog.ts";

const repo = path.join(import.meta.dirname, "..");

/** An RPGTL server on a state folder of its own. */
interface Rpgtl {
  readonly url: string;
  readonly state: string;
}

/** A fixture game opened in RPGTL. */
export interface OpenedGame {
  readonly id: string;
  /** The game's catalog as RPGTL saved it. */
  readonly saved: () => Promise<{ entries: Pick<Entry, "source" | "translation">[] }>;
  /**
   * Opens the game as the browser plays it, in a tab of its own. The test fails if the game logs
   * an error or throws one.
   */
  readonly play: () => Promise<Page>;
}

type Kind = "MV" | "MZ" | "real-MV";

const gameErrors = new WeakMap<Page, string[]>();

/** The errors a game page has logged or thrown so far. */
export const errorsIn = (game: Page) => gameErrors.get(game) ?? [];

/** An X display of its own, so that games RPGTL starts in NW.js open no window on the desktop. */
async function startXvfb(): Promise<{ display: string; stop: () => Promise<void> }> {
  const xvfb = spawn(
    "Xvfb",
    ["-displayfd", "3", "-nolisten", "tcp", "-screen", "0", "1280x800x24"],
    {
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    },
  );
  const output: string[] = [];
  xvfb.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  const exited = new Promise<void>((resolve) => xvfb.once("close", () => resolve()));
  const display = await new Promise<string>((resolve, reject) => {
    xvfb.once("error", (error) =>
      reject(new Error(`Couldn't start Xvfb, which the e2e tests need: ${error.message}`)),
    );
    void exited.then(() => reject(new Error(`Xvfb exited:\n${output.join("")}`)));
    xvfb.stdio[3]?.on("data", (chunk: Buffer) => resolve(`:${chunk.toString().trim()}`));
  });
  return {
    display,
    stop: async () => {
      xvfb.kill("SIGTERM");
      await exited;
    },
  };
}

async function startRpgtl(
  dir: string,
  display: string,
): Promise<{ url: string; stop: () => Promise<void> }> {
  // RPGTL_E2E_ARCHIVE names an unpacked portable download to test instead of this checkout.
  const archive = process.env.RPGTL_E2E_ARCHIVE;
  const command = archive ? path.join(archive, "rpgtl") : "node";
  const args = archive ? [] : ["apps/server/src/main.ts"];
  const { WAYLAND_DISPLAY: _, ...env } = process.env;
  const server = spawn(command, args, {
    cwd: repo,
    env: {
      ...env,
      DISPLAY: display,
      // NW.js picks Wayland in a Wayland session even without WAYLAND_DISPLAY.
      XDG_SESSION_TYPE: "x11",
      RPGTL_OPEN_PAGE: "0",
      RPGTL_DIR: path.join(dir, "state"),
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_STATE_HOME: path.join(dir, "state-home"),
      PORT: "0",
      RPGTL_DEV: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  server.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.kill("SIGTERM");
      reject(new Error(`RPGTL wasn't ready:\n${output.join("")}`));
    }, 30_000);
    void exited.then(() =>
      reject(new Error(`RPGTL exited before it was ready:\n${output.join("")}`)),
    );
    createInterface({ input: server.stdout }).on("line", (line) => {
      output.push(line + "\n");
      const ready = /RPGTL is ready: (\S+?)\/?$/.exec(line);
      if (!ready?.[1]) return;
      clearTimeout(timer);
      resolve(ready[1]);
    });
  });
  return {
    url,
    stop: async () => {
      server.kill("SIGTERM");
      await exited;
    },
  };
}

export const test = base.extend<
  { openGame: (kind: Kind) => Promise<OpenedGame> },
  { rpgtl: Rpgtl }
>({
  rpgtl: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads the fixtures a fixture needs from this pattern.
    async ({}, use) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "rpgtl-e2e-"));
      await mkdir(path.join(dir, "state"), { recursive: true });
      const xvfb = await startXvfb();
      const server = await startRpgtl(dir, xvfb.display);
      await use({ url: server.url, state: path.join(dir, "state") });
      await server.stop();
      await xvfb.stop();
      await rm(dir, { recursive: true, force: true });
    },
    { scope: "worker" },
  ],
  openGame: async ({ rpgtl, page, context }, use, testInfo) => {
    const games: Page[] = [];
    await use(async (kind) => {
      const root = testInfo.outputPath("game");
      const webRoot = kind === "real-MV" ? await mvGame(root) : await fixture(root, kind);
      await page.goto(rpgtl.url);
      await page.locator("#game-path").fill(webRoot);
      await page.getByRole("button", { name: "Open", exact: true }).click();
      // Every test of a worker opens a copy of the same game, which RPGTL takes for another
      // version of the copy an earlier test opened.
      const title = page.getByRole("heading", { level: 1, name: "Fixture Adventure" });
      const keepBoth = page.getByRole("button", { name: "Keep both" });
      await expect(title.or(keepBoth)).toBeVisible();
      if (await keepBoth.isVisible()) await keepBoth.click();
      await expect(page.locator("h1")).toHaveText("Fixture Adventure");
      const id = new URL(page.url()).pathname.slice("/games/".length);
      return {
        id,
        saved: async () =>
          JSON.parse(await readFile(path.join(rpgtl.state, "games", id, "catalog.json"), "utf8")),
        play: async () => {
          const game = await context.newPage();
          const errors: string[] = [];
          game.on("console", (message) => {
            if (message.type() === "error")
              errors.push(`${message.text()} ${message.location().url}`.trim());
          });
          game.on("pageerror", (error) => errors.push(error.stack ?? error.message));
          gameErrors.set(game, errors);
          games.push(game);
          await game.goto(`${rpgtl.url}/game/${id}/`);
          return game;
        },
      };
    });
    for (const game of games) expect(errorsIn(game), "errors in the game").toEqual([]);
  },
});

export { expect };
