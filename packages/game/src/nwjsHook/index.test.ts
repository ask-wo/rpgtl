import { test, expect, afterEach } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildScript } from "../build.ts";
import { hookScript } from "../scripts.ts";
import { gameFiles } from "@rpgtl/contracts";
import { FixtureDatabase, fixtureEntries } from "../testUtils/catalog.ts";
import { imageEntries } from "@rpgtl/domain";
import {
  fixture,
  imageFixtureKey,
  plugins,
  readerLine,
  writeImageReads,
} from "../testUtils/fixture.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const json = (file: string, value: unknown) => writeFile(file, JSON.stringify(value));

let scripts: Promise<Record<"nwjs-hook.js" | "runtime.js" | "map-view.js", string>> | undefined;
/** The hook, runtime and map view, built once for all tests. */
const builtScripts = () =>
  (scripts ??= Promise.all([
    buildScript("nwjs-hook.js"),
    buildScript("runtime.js"),
    buildScript("map-view.js"),
  ]).then(([hook, runtime, mapView]) => ({
    "nwjs-hook.js": hook,
    "runtime.js": runtime,
    "map-view.js": mapView,
  })));

function importTranslations(database: FixtureDatabase, name = "Héros") {
  database.translate(({ location, source }) => {
    if (location._tag === "RecordField" && location.table === "actors" && source === "Hero")
      return name;
    if (
      location._tag === "RecordField" &&
      location.table === "items" &&
      location.field === "description"
    )
      return "Restore \\V[1] HP.";
    if (location._tag === "PluginSetting") return "Credits";
    return undefined;
  });
}

async function editItems(webRoot: string) {
  const file = path.join(webRoot, "data", "Items.json");
  const items = JSON.parse(await readFile(file, "utf8"));
  items[1].description = "Recover a lot.";
  await json(file, items);
  return items;
}

async function hookPage(stateDir: string, id: string, webRoot: string) {
  const elements: any[] = [];
  const document = {
    baseURI: `file://${webRoot}/index.html`,
    body: { append: (element: any) => elements.push(element) },
    currentScript: null,
    visibilityState: "visible",
    hasFocus: () => true,
    addEventListener() {},
    createElement: () => {
      const nodes = new Map<string, any>();
      const shadow = {
        innerHTML: "",
        querySelector: (selector: string) => {
          if (!nodes.has(selector)) nodes.set(selector, { textContent: "", addEventListener() {} });
          return nodes.get(selector);
        },
        get textContent() {
          return [...nodes.values()].map((node) => node.textContent).join(" ");
        },
      };
      return {
        style: { cssText: "" },
        shadowRoot: shadow,
        attachShadow: () => shadow,
        addEventListener() {},
      };
    },
  };
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  class Xhr {
    url = "";
    listeners = new Map<string, () => void>();
    open(_method: string, url: string) {
      this.url = url;
    }
    addEventListener(event: string, listener: () => void) {
      this.listeners.set(event, listener);
    }
  }
  const code = await readFile(path.join(stateDir, gameFiles(id).nwjsHook), "utf8");
  const listeners = new Map<string, (event: any) => void>();
  const fetched: string[] = [];
  const window: Record<string, any> = {
    addEventListener: (type: string, listener: (event: any) => void) =>
      listeners.set(type, listener),
    fetch: async (input: string) => void fetched.push(input),
    outerWidth: 832,
    outerHeight: 663,
    innerWidth: 816,
    innerHeight: 624,
    screenX: 40,
    screenY: 30,
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 1.5,
    requestAnimationFrame: () => 0,
    setTimeout: () => 0,
    FontFace: class {
      family: string;
      source: string;
      constructor(family: string, source: string) {
        this.family = family;
        this.source = source;
      }
    },
  };
  const sources = [0, 1, 2].map(() => ({ prototype: {} as object }));
  const values = new WeakMap<object, string>();
  for (const { prototype } of sources)
    Object.defineProperty(prototype, "src", {
      configurable: true,
      get() {
        return values.get(this) ?? "";
      },
      set(value: string) {
        values.set(this, value);
      },
    });
  const mainModule = { filename: "nw.js main module" };
  const cwd: string[] = [];
  const consoleErrors: unknown[][] = [];
  const console = {
    error: (...args: unknown[]) => consoleErrors.push(args),
    warn: (...args: unknown[]) => args,
  };
  new Function(
    "globalThis",
    "window",
    "document",
    "console",
    "XMLHttpRequest",
    "URL",
    "Blob",
    "setInterval",
    "HTMLImageElement",
    "HTMLScriptElement",
    "HTMLMediaElement",
    code,
  )(
    // NW.js's global object, with its own Error, URL and so on, and Node's require and process.
    Object.assign(Object.create(globalThis), {
      require,
      process: {
        mainModule,
        chdir: (dir: string) => cwd.push(dir),
        versions: { nw: "0.117.0", chromium: "142.0.0.0" },
        arch: "x64",
      },
    }),
    window,
    document,
    console,
    Xhr,
    Object.assign(class extends URL {}, {
      createObjectURL: (blob: Blob) => {
        const url = `blob:${blobs.size}`;
        blobs.set(url, blob);
        return url;
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    }),
    Blob,
    () => 0,
    ...sources,
  );
  const request = (name: string) => {
    const xhr = new Xhr();
    xhr.open("GET", name);
    return xhr;
  };
  return {
    code,
    mainModule,
    cwd,
    elements,
    window,
    fetched,
    image: Object.create(sources[0]!.prototype) as { src: string },
    listeners,
    console,
    consoleErrors,
    request,
    async load(name: string) {
      const xhr = request(`data/${name}`);
      const blob = blobs.get(xhr.url);
      const text = blob
        ? await blob.text()
        : await readFile(path.join(webRoot, "data", name), "utf8");
      if (blob) {
        expect(blob.type.split(";")[0]).toBe("application/json");
        xhr.listeners.get("loadend")!();
        expect(revoked).toContain(xhr.url);
      }
      return JSON.parse(text);
    },
  };
}

/**
 * The fixture game with its catalog saved, and the hook file the server writes for NW.js, built
 * the same way from the same scripts.
 */
async function launchedHook() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rpgtl-nwjs-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  const root = path.join(dir, "game");
  await fixture(root, "MV", false);
  const id = "fixture";
  const databaseFile = path.join(stateDir, gameFiles(id).database);
  const database = new FixtureDatabase(databaseFile);
  database.add(await fixtureEntries(root));
  await mkdir(path.join(stateDir, gameFiles(id).logs), { recursive: true });
  const log = path.join(stateDir, gameFiles(id).logs, "nwjs.log");
  await writeFile(log, "");
  const config = {
    database: databaseFile,
    data: path.join(root, "data"),
    erased: path.join(stateDir, gameFiles(id).erasedImages),
    images: path.join(stateDir, gameFiles(id).imageResults),
    log,
    playtime: path.join(stateDir, gameFiles(id).playtime),
    root,
  };
  await writeFile(
    path.join(stateDir, gameFiles(id).nwjsHook),
    hookScript(config, await builtScripts()),
  );
  return {
    stateDir,
    database,
    id,
    root,
    log,
    page: await hookPage(stateDir, id, root),
    /** A new game window, as after F5. */
    reload: () => hookPage(stateDir, id, root),
  };
}

test("Hook logs the game's errors, rejections and console errors, up to a limit", async () => {
  const { page, log } = await launchedHook();
  expect(page.code).toContain("Passability map");
  const error = new Error("boom");
  page.listeners.get("error")!({
    message: "Uncaught Error: boom",
    filename: "js/plugins/Quest.js",
    lineno: 3,
    colno: 7,
    error,
  });
  page.listeners.get("unhandledrejection")!({ reason: "no file" });
  page.console.error("Failed to load:", "img/faces/Actor1.png");
  expect(page.consoleErrors).toEqual([["Failed to load:", "img/faces/Actor1.png"]]);
  page.console.warn("RPGTL: img/pictures/Sign.png could not be loaded, shown blank.");
  page.console.warn("A plugin's own warning");
  for (let i = 0; i < 120; i++) page.console.error("again");
  const lines = (await readFile(log, "utf8"))
    .split("\n")
    .filter((line) => line.startsWith("Game error:"));
  expect(lines[0]).toStartWith(
    "Game error: Uncaught Error: boom at js/plugins/Quest.js:3:7 Error: boom",
  );
  expect(lines[1]).toBe("Game error: Unhandled rejection: no file");
  expect(lines[2]).toBe("Game error: Failed to load: img/faces/Actor1.png");
  expect(lines[3]).toBe(
    "Game error: RPGTL: img/pictures/Sign.png could not be loaded, shown blank.",
  );
  expect(lines).toHaveLength(100);
  expect(lines.at(-1)).toBe("Game error: again (later errors are not logged)");
});

test("Hook logs how far the game's start got", async () => {
  const { page, log } = await launchedHook();
  page.listeners.get("load")!({});
  const lines = (await readFile(log, "utf8"))
    .split("\n")
    .filter((line) => line.startsWith("Start:"));
  expect(lines[0]).toMatch(
    /^Start: hook started in NW\.js 0\.117\.0 \(Chromium 142\.0\.0\.0\) on .+ x64, window 832x663 \(page 816x624\) at 40,30 on a 1920x1080 screen at scale 1\.5, page visible and focused$/,
  );
  expect(lines[1]).toStartWith("Start: page loaded, ");
});

test("Hook translates and falls back per file", async () => {
  const { database, root, page, log, reload } = await launchedHook();
  importTranslations(database);
  const items = await editItems(root);
  expect((await page.load("Actors.json"))[1].name).toBe("Héros");
  expect(await page.load("Items.json")).toEqual(items);
  expect(await page.load("Items.json")).toEqual(items);
  expect(await page.load("Map001.json")).toEqual(
    JSON.parse(await readFile(path.join(root, "data", "Map001.json"), "utf8")),
  );
  expect(page.request("js/main.js").url).toBe("js/main.js");
  importTranslations(database, "Champion");
  expect((await page.load("Actors.json"))[1].name, "until F5").toBe("Héros");
  expect((await (await reload()).load("Actors.json"))[1].name).toBe("Champion");
  const lines = (await readFile(log, "utf8"))
    .split("\n")
    .filter((line) => line.startsWith("RPGTL:"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("RPGTL: some text is shown untranslated");
  expect(lines[0]).toContain("Items.json");
  expect(page.elements).toHaveLength(1);
  expect(page.elements[0].shadowRoot.textContent).toContain(
    "RPGTL: some text is shown untranslated",
  );
  expect(page.elements[0].shadowRoot.textContent).toContain("Items.json");
});

test("Hook leaves the game's text alone while its translation switch is off", async () => {
  const { database, root, page, reload } = await launchedHook();
  importTranslations(database);
  database.set("isTranslationOn", false);
  expect((await page.load("Actors.json"))[1].name).toBe("Hero");
  expect(await page.load("Map001.json")).toEqual(
    JSON.parse(await readFile(path.join(root, "data", "Map001.json"), "utf8")),
  );
  page.window.$plugins = structuredClone(plugins);
  expect(page.window.$plugins).toEqual(plugins);
  expect(page.elements).toHaveLength(0);
  database.set("isTranslationOn", true);
  expect((await (await reload()).load("Actors.json"))[1].name).toBe("Héros");
});

test("Hook points the engine's main module at the game's index.html, where the engine saves, and runs in the game's folder", async () => {
  const { root, page } = await launchedHook();
  expect(page.mainModule.filename).toBe(path.join(root, "index.html"));
  expect(page.cwd).toEqual([root]);
});

test("Hook finds files whose letter case differs from the disk", async () => {
  const { root, page } = await launchedHook();
  await mkdir(path.join(root, "img", "faces"), { recursive: true });
  await writeFile(path.join(root, "img", "faces", "foo.png"), "x");
  const url = (name: string) => `file://${root}/${name}`;
  page.image.src = url("Img/Faces/Foo.PNG");
  expect(page.image.src).toBe(url("img/faces/foo.png"));
  page.image.src = url("img/faces/missing.png");
  expect(page.image.src).toBe(url("img/faces/missing.png"));
  page.image.src = "blob:1";
  expect(page.image.src).toBe("blob:1");
  await page.window.fetch("Img/Faces/FOO.png");
  expect(page.fetched).toEqual([url("img/faces/foo.png")]);
  const font = new page.window.FontFace("Main", 'url("Img/Faces/Foo.PNG")');
  expect(font.source).toBe(`url("${url("img/faces/foo.png")}")`);
  expect(page.request("Data/Actors.JSON").url).toStartWith("blob:");
});

test("Hook loads images named after translated text", async () => {
  const { database, page, root } = await launchedHook();
  database.translate((entry) => (entry.source === "致谢" ? "Credits" : undefined));
  await mkdir(path.join(root, "img", "menus"), { recursive: true });
  await writeFile(path.join(root, "img", "menus", "Com_致谢.png"), "");
  expect((await page.load("System.json")).rpgtlImages).toEqual({
    "img/menus/Com_Credits": { file: "Com_致谢" },
  });
});

test("Hook translates plugin parameters as js/plugins.js sets them", async () => {
  const { database, page } = await launchedHook();
  importTranslations(database);
  page.window.$plugins = structuredClone(plugins);
  expect(page.window.$plugins).toEqual([
    {
      ...plugins[0],
      parameters: { ...plugins[0]!.parameters, "Command Name": "Credits", Lines: '["Credits"]' },
    },
    plugins[1],
  ]);

  const changed = structuredClone(plugins);
  changed[0]!.parameters["Command Name"] = "鸣谢";
  page.window.$plugins = changed;
  expect(page.window.$plugins).toEqual(changed);
  expect(page.elements[0].shadowRoot.textContent).toContain("plugins.js");
});

test.each([
  ["An unreadable", (file: string) => writeFile(file, "{")],
  [
    "A wrongly shaped",
    async (file: string) => {
      const spoilt = new FixtureDatabase(file);
      const database = new DatabaseSync(spoilt.file);
      database.exec(`update settings set value = '"yes"' where name = 'isTranslationOn'`);
      database.close();
    },
  ],
])("%s database runs the whole game untranslated", async (_, spoil) => {
  const { stateDir, database, id, root, page, log } = await launchedHook();
  importTranslations(database);
  const file = path.join(stateDir, gameFiles(id).database);
  await rm(file);
  await spoil(file);
  for (const name of ["Actors.json", "Items.json"])
    expect(await page.load(name)).toEqual(
      JSON.parse(await readFile(path.join(root, "data", name), "utf8")),
    );
  const lines = (await readFile(log, "utf8"))
    .split("\n")
    .filter((line) => line.startsWith("RPGTL:"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("RPGTL: translations could not be loaded");
  expect(lines[0]).toContain(file);
  expect(page.elements).toHaveLength(1);
  expect(page.elements[0].shadowRoot.textContent).toContain(
    "RPGTL: translations could not be loaded",
  );
  expect(page.elements[0].shadowRoot.textContent).toContain(file);
});

test("A game without a database stays silent", async () => {
  const { stateDir, id, root, page, log } = await launchedHook();
  await rm(path.join(stateDir, gameFiles(id).database));
  expect(await page.load("Actors.json")).toEqual(
    JSON.parse(await readFile(path.join(root, "data", "Actors.json"), "utf8")),
  );
  expect(await readFile(log, "utf8")).not.toContain("RPGTL:");
  expect(page.elements).toHaveLength(0);
});

test("Hook hands the translated image blocks to the game, with their erased images as files", async () => {
  const { stateDir, database, id, root, page, log, reload } = await launchedHook();
  const system = JSON.parse(await readFile(path.join(root, "data/System.json"), "utf8"));
  await json(path.join(root, "data/System.json"), { ...system, encryptionKey: imageFixtureKey });
  const image = "img/widget-ui/panels/actions/Notice";
  expect((await page.load("System.json")).rpgtlImageText).toBeUndefined();
  await writeImageReads(
    stateDir,
    id,
    {
      [image]: {
        file: `${image}.rpgmvp`,
        lines: [readerLine("开始游戏"), readerLine("退出", [100, 200, 400, 230])],
      },
    },
    false,
  );
  // Read results without translations draw nothing.
  const results = JSON.parse(
    await readFile(path.join(stateDir, gameFiles(id).imageResults), "utf8"),
  );
  database.add(imageEntries(results));
  expect((await (await reload()).load("System.json")).rpgtlImageText).toBeUndefined();

  database.translate(({ location, source }) =>
    location._tag === "ImageLines" && location.image === image
      ? source === "退出"
        ? "Quit"
        : "Begin"
      : undefined,
  );
  const hints = (await (await reload()).load("System.json")).rpgtlImageText[image];
  expect(hints.blocks.map((block: any) => block.text)).toEqual(["Begin", "Quit"]);
  const [name] = hints.erased.split("/").slice(-1);
  expect(hints.erased).toBe(`file://${stateDir}/${gameFiles(id).erasedImages}/${name}`);
  expect(results.images[image].erased).toBe(name);

  database.translate((entry) => (entry.source === "退出" ? "Leave" : undefined));
  database.set("letteringWeight", "bold");
  const edited = (await (await reload()).load("System.json")).rpgtlImageText[image];
  expect(edited.blocks.map((block: any) => [block.text, block.bold])).toEqual([
    ["Begin", true],
    ["Leave", true],
  ]);

  // A whole image kept original in the game.
  database.set("untranslatedImages", [image]);
  expect((await (await reload()).load("System.json")).rpgtlImageText).toBeUndefined();
  // Read results of the wrong shape draw nothing, and the log says why.
  database.set("untranslatedImages", []);
  const imagesFile = path.join(stateDir, gameFiles(id).imageResults);
  await writeFile(imagesFile, JSON.stringify({ ...results, images: { [image]: { lines: 1 } } }));
  expect((await (await reload()).load("System.json")).rpgtlImageText).toBeUndefined();
  expect(await readFile(log, "utf8")).toContain(`RPGTL: image text could not be loaded`);
});

test("Hook adds the game's playtime to its file and leaves a file it can't read alone", async () => {
  const { page, stateDir, id, log } = await launchedHook();
  const file = path.join(stateDir, gameFiles(id).playtime);
  page.window.rpgtlRecordPlaytime(30);
  page.window.rpgtlRecordPlaytime(12);
  const saved = JSON.parse(await readFile(file, "utf8"));
  expect(saved.seconds).toBe(42);
  expect(Date.parse(saved.lastPlayed)).toBeGreaterThan(Date.now() - 60_000);
  await writeFile(file, "{");
  page.window.rpgtlRecordPlaytime(30);
  expect(await readFile(file, "utf8")).toBe("{");
  expect(await readFile(log, "utf8")).toContain("RPGTL: playtime could not be saved");
});
