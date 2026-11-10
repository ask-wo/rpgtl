#!/usr/bin/env node
// Drives a verification run's RPGTL page in headless Chrome over the DevTools protocol.
// Usage: node drive.ts <run folder> <steps.ts>
// steps.ts default-exports async ({ page, openPage, api, run, log }) => { ... }; see SKILL.md.
// Every action goes to <run>/evidence/actions.log, the page's console and errors to
// console.log, and screenshots to <run>/evidence/NN-<name>.png. Dialogs (confirm) are
// accepted and logged. Chrome stops when the steps finish or throw.
import {
  appendFileSync,
  existsSync,
  globSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [runArg, stepsArg] = process.argv.slice(2);
if (!runArg || !stepsArg) {
  console.error("Usage: node drive.ts <run folder> <steps.ts>");
  process.exit(2);
}
const dir = path.resolve(runArg);
const url = readFileSync(path.join(dir, "url"), "utf8").trim();
const run = {
  dir,
  url,
  state: path.join(dir, "state"),
  // The folder the page shows: launch.sh links $run/game to one whose path names no user.
  game: realpathSync(path.join(dir, "game")),
  evidence: path.join(dir, "evidence"),
};
await mkdir(run.evidence, { recursive: true });
const keyCodes: Record<string, number> = {
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Escape: 27,
  " ": 32,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};
const stamp = () => new Date().toISOString().slice(11, 23);
const log = (line: string) => {
  appendFileSync(path.join(run.evidence, "actions.log"), `${stamp()} ${line}\n`);
  console.log(line);
};
const consoleLog = (line: string) =>
  appendFileSync(path.join(run.evidence, "console.log"), `${stamp()} ${line}\n`);

function findChrome() {
  if (process.env.RPGTL_VERIFY_CHROME) return process.env.RPGTL_VERIFY_CHROME;
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  const builds = existsSync(cache) ? globSync("*/chrome-*/chrome*", { cwd: cache }) : [];
  const found = builds
    .filter((file) => /chrome-headless-shell$|chrome-linux64\/chrome$/.test(file))
    .toSorted()
    .toReversed();
  const shell = found.find((file) => file.endsWith("headless-shell")) ?? found[0];
  if (shell) return path.join(cache, shell);
  for (const name of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    const binary = (process.env.PATH ?? "")
      .split(":")
      .map((folder) => path.join(folder, name))
      .find((file) => existsSync(file));
    if (binary) return binary;
  }
  throw new Error("No Chrome found; set RPGTL_VERIFY_CHROME to a Chrome or Chromium binary.");
}

// Chrome gets its own process group (setsid) and profile, so cleanup.sh can stop exactly it.
const profile = path.join(dir, "browser");
rmSync(path.join(profile, "DevToolsActivePort"), { force: true });
const chrome = spawn(
  "setsid",
  [
    findChrome(),
    "--headless",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--window-size=1280,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const chromeExited = once(chrome, "close");
writeFileSync(path.join(dir, "browser.pid"), String(chrome.pid));

async function devtoolsPort() {
  for (let i = 0; i < 100; i++) {
    const file = path.join(profile, "DevToolsActivePort");
    if (existsSync(file)) return readFileSync(file, "utf8").split("\n")[0];
    await sleep(100);
  }
  throw new Error("Chrome did not open a DevTools port.");
}
const cdpBase = `http://127.0.0.1:${await devtoolsPort()}`;
let shots = 0;

type Handler = (params: any) => void;
class Page {
  private ws!: WebSocket;
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Handler[]>();
  /** Messages of dialogs that came up and were accepted. */
  dialogs: string[] = [];

  static async open(target: string) {
    const page = new Page();
    const info = await (
      await fetch(`${cdpBase}/json/new?${encodeURI(target)}`, { method: "PUT" })
    ).json();
    page.ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      page.ws.onopen = resolve;
      page.ws.onerror = reject;
    });
    page.ws.onmessage = (event) => page.receive(JSON.parse(String(event.data)));
    page.on("Page.javascriptDialogOpening", ({ message }) => {
      page.dialogs.push(message);
      log(`dialog accepted: ${message}`);
      void page.send("Page.handleJavaScriptDialog", { accept: true });
    });
    page.on("Runtime.consoleAPICalled", ({ type, args }) =>
      consoleLog(`${type}: ${args.map((a: any) => a.value ?? a.description).join(" ")}`),
    );
    page.on("Runtime.exceptionThrown", ({ exceptionDetails }) =>
      consoleLog(`exception: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`),
    );
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // The user runs the page in dark mode, so screenshots show it that way.
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    return page;
  }

  private receive(message: any) {
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method) {
      for (const handler of this.listeners.get(message.method) ?? []) handler(message.params);
    }
  }

  on(method: string, handler: Handler) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), handler]);
  }

  /** Sends a raw DevTools protocol command. */
  send(method: string, params: object = {}): Promise<any> {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Loads a path on RPGTL (or a full URL) and waits for the load event. */
  async goto(target: string) {
    const loaded = new Promise((resolve) => this.on("Page.loadEventFired", resolve));
    await this.send("Page.navigate", { url: new URL(target, url).href });
    await loaded;
    log(`goto ${target}`);
  }

  /** Runs an expression or a function (with JSON arguments) in the page and returns its value. */
  async eval<T = any>(
    code: string | ((...args: any[]) => unknown),
    ...args: unknown[]
  ): Promise<T> {
    const expression = typeof code === "function" ? `(${code})(...${JSON.stringify(args)})` : code;
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (exceptionDetails)
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  /** Waits until a CSS selector matches a visible element. */
  waitFor(selector: string, ms = 10_000) {
    return this.waitUntil(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el && !el.closest("[hidden]") && el.getClientRects().length > 0; })()`,
      ms,
      selector,
    );
  }

  /** Waits until a JavaScript expression is truthy in the page. */
  async waitUntil(expression: string, ms = 10_000, label = expression) {
    const end = Date.now() + ms;
    for (;;) {
      if (await this.eval(expression)) return;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
      await sleep(50);
    }
  }

  // The page disables its controls while a task runs and ignores clicks then, so wait for
  // the target to be enabled as well as visible.
  private async center(selector: string) {
    await this.waitFor(selector);
    await this.waitUntil(
      `!document.querySelector(${JSON.stringify(selector)}).disabled`,
      10_000,
      `${selector} to be enabled`,
    );
    const box = await this.eval((sel: string) => {
      const el = document.querySelector(sel)!;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    }, selector);
    if (!box) throw new Error(`${selector} is hidden`);
    return box as { x: number; y: number };
  }

  /** Clicks the middle of the first match with real mouse events. */
  async click(selector: string) {
    const { x, y } = await this.center(selector);
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    log(`click ${selector}`);
  }

  /**
   * Clicks the first visible button or link whose text is exactly `text`, or matches it as a
   * RegExp, such as `/^Untranslated/` for a button that ends with a count.
   */
  async clickText(text: string | RegExp, within = "body") {
    const pattern = typeof text === "string" ? null : [text.source, text.flags];
    const found = await this.eval(
      (label: string, regExp: [string, string] | null, scope: string) => {
        const matches = (content: string) =>
          regExp ? new RegExp(regExp[0], regExp[1]).test(content) : content === label;
        const match = [...document.querySelectorAll(`${scope} button, ${scope} a`)].find(
          (el) => matches(el.textContent!.trim()) && el.getClientRects().length > 0,
        );
        if (!match) return null;
        match.setAttribute("data-verify-target", "1");
        return true;
      },
      String(text),
      pattern,
      within,
    );
    if (!found) throw new Error(`No visible button or link "${text}" in ${within}`);
    await this.click("[data-verify-target]");
    await this.eval(() =>
      document.querySelector("[data-verify-target]")?.removeAttribute("data-verify-target"),
    );
    log(`  (that was "${text}")`);
  }

  /**
   * A selector for the element whose `aria-label` is `label`, with the quotes and backslashes in
   * it escaped, as in `textarea[aria-label="English for Recover \\V[1] HP."]`.
   */
  labelled(label: string, tag = "") {
    return `${tag}[aria-label="${label.replace(/["\\]/g, "\\$&")}"]`;
  }

  /** Replaces an input's or textarea's text by typing it. */
  async fill(selector: string, text: string) {
    await this.click(selector);
    await this.eval(
      (sel: string) => (document.querySelector(sel) as HTMLInputElement).select(),
      selector,
    );
    await this.send("Input.insertText", { text });
    log(`fill ${selector} = ${JSON.stringify(text)}`);
  }

  /**
   * Opens the page's select whose trigger matches `selector`, clicks the option whose text is
   * `label`, and waits for the list to close. Closed lists stay in the DOM hidden, so only options
   * in an open one count.
   */
  async select(selector: string, label: string) {
    const options = `[data-slot="select-content"][data-open] [role="option"]`;
    const find = `[...document.querySelectorAll(${JSON.stringify(options)})].find((each) => each.textContent.trim() === ${JSON.stringify(label)})`;
    await this.click(selector);
    await this.waitUntil(`!!${find}`, 10_000, `option "${label}" in ${selector}`);
    await this.eval(`${find}.click()`);
    await this.waitUntil(
      `!document.querySelector('[data-slot="select-content"][data-open]')`,
      10_000,
      `${selector} to close`,
    );
    log(`select ${selector} = ${label}`);
  }

  /**
   * Presses a key, e.g. press("s", ["Control"]) or press("Enter"). A real engine reads keys once
   * per frame, so in a game hold them: press("ArrowRight", [], 300) walks a few tiles.
   */
  async press(key: string, modifiers: ("Alt" | "Control" | "Meta" | "Shift")[] = [], holdMs = 0) {
    const bits = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
    const mask = modifiers.reduce((sum, m) => sum | bits[m], 0);
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key === " " ? "Space" : key;
    const keyCode =
      key.length === 1
        ? key.toUpperCase().charCodeAt(0)
        : (keyCodes[key] ?? (/^F\d+$/.test(key) ? 111 + Number(key.slice(1)) : 0));
    const base = { key, code, modifiers: mask, windowsVirtualKeyCode: keyCode };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    if (holdMs) await sleep(holdMs);
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    log(`press ${[...modifiers, key].join("+")}${holdMs ? ` for ${holdMs}ms` : ""}`);
  }

  /** The text of the first match, or null. */
  text(selector: string) {
    return this.eval(
      (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? null,
      selector,
    ) as Promise<string | null>;
  }

  /**
   * Saves a screenshot as evidence/NN-<name>.png and returns its path: of the whole page, or of
   * the first element `selector` matches with `margin` pixels around it.
   */
  async shot(name: string, selector?: string, margin = 8) {
    const clip =
      selector === undefined
        ? undefined
        : await this.eval(
            (target: string, around: number) => {
              const element = document.querySelector(target);
              if (!element) throw new Error(`No element matches ${target}`);
              const box = element.getBoundingClientRect();
              const x = Math.max(0, box.x + window.scrollX - around);
              const y = Math.max(0, box.y + window.scrollY - around);
              return {
                x,
                y,
                width: box.right + window.scrollX + around - x,
                height: box.bottom + window.scrollY + around - y,
                scale: 1,
              };
            },
            selector,
            margin,
          );
    const { data } = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      ...(clip && { clip }),
    });
    const file = path.join(run.evidence, `${String(++shots).padStart(2, "0")}-${name}.png`);
    await writeFile(file, Buffer.from(data, "base64"));
    log(`screenshot ${path.basename(file)}`);
    return file;
  }
}

// The same token-checked API the page calls, for reading state after a UI action.
const token = /name="rpgtl-token" content="([0-9a-f]+)"/.exec(await (await fetch(url)).text())![1];
async function api<T = any>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(new URL(`/api/${route}`, url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-RPGTL-Token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const value = text === "" ? undefined : JSON.parse(text);
  if (!response.ok) throw new Error(`${route}: ${response.status} ${value?.error ?? text}`);
  return value as T;
}

const openPage = async (target = "/") => {
  const page = await Page.open("about:blank");
  await page.goto(target);
  return page;
};

let exitCode = 0;
try {
  const steps = (await import(path.resolve(stepsArg))).default;
  log(`steps ${path.resolve(stepsArg)} on ${url}`);
  await steps({ page: await openPage("/"), openPage, api, run, log });
  log("steps passed");
} catch (error) {
  log(`steps FAILED: ${(error as Error).stack ?? error}`);
  exitCode = 1;
} finally {
  process.kill(-chrome.pid!, "SIGTERM");
  await chromeExited;
  rmSync(path.join(dir, "browser.pid"), { force: true });
}
process.exit(exitCode);
