import { Catalog, ImageReadResults, Plugins } from "@rpgtl/contracts";
import {
  applyPluginTranslations,
  applyTranslations,
  withSystemImages,
  decodeGameFile,
  translatedImageNames,
  imageTextHints,
} from "@rpgtl/domain";
import { Result, Schema, Struct } from "effect";
import type { HookConfig } from "../scripts.ts";
import { matchCase } from "./casePath.ts";
import { logStart } from "./startLog.ts";

declare const rpgtl: HookConfig;

const nodeRequire = (globalThis as unknown as { require: NodeRequire }).require;
const fs = nodeRequire("fs") as typeof import("node:fs");
const path = nodeRequire("path") as typeof import("node:path");
const nodeUrl = nodeRequire("url") as typeof import("node:url");

// NW.js runs the game's index.html from RPGTL's app folder. The engine saves next to the main
// module, and plugins read files by paths relative to the working folder, so both point at the game.
const nodeProcess = (globalThis as unknown as { process: NodeJS.Process }).process;
nodeProcess.mainModule!.filename = path.join(path.dirname(rpgtl.data), "index.html");
nodeProcess.chdir(rpgtl.root);
// Only the fields the hook reads, so a big catalog's glossary and runs aren't decoded too.
const decodeCatalog = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct(
      Struct.pick(Catalog.fields, [
        "entries",
        "translate",
        "imageBold",
        "imageFont",
        "unchangedImages",
      ]),
    ),
  ),
);
const decodeImages = Schema.decodeUnknownSync(Schema.fromJsonString(ImageReadResults));
// The game window reads the catalog once, so data files loaded later don't mix old and new
// English. F5 reads it again.
let loaded: { catalog: ReturnType<typeof decodeCatalog> | undefined } | undefined;
let catalogError: string | undefined;
const files = new Set<string>();
let host: HTMLDivElement | undefined;
let pending = false;

const changedHeading = "RPGTL: some text is shown untranslated";
const catalogHeading = "RPGTL: translations could not be loaded";
const changedText = (names: string) =>
  `The text in ${names} no longer matches RPGTL's saved translations, probably because the game was updated or its files were edited. RPGTL shows the original text for these files so the game still runs.\n\nTo fix it, open RPGTL, open this game's folder again with Choose folder… or Open (translations of unchanged text are kept), then translate the new text and reload the game window with F5.`;
const catalogText = (error: string) =>
  `RPGTL's translation file for this game (${rpgtl.catalog}) could not be read: ${error}. The whole game is shown untranslated.\n\nTo fix it, import a backup from the backups folder in RPGTL, then reload the game window with F5.`;

function log(heading: string, text: string) {
  try {
    fs.appendFileSync(rpgtl.log, `${heading}: ${text.replace(/\n+/g, " ")}\n`);
  } catch {}
}

// NW.js shows no console, so errors in the game's own scripts go to the same log, up to a limit.
const errorLimit = 100;
let errors = 0;
function logGameError(text: string) {
  if (++errors > errorLimit) return;
  log("Game error", errors === errorLimit ? `${text} (later errors are not logged)` : text);
}
const describe = (value: unknown) =>
  value instanceof Error ? (value.stack ?? value.message) : String(value);
window.addEventListener("error", (event) =>
  logGameError(
    `${event.message} at ${event.filename}:${event.lineno}:${event.colno}${event.error instanceof Error ? ` ${describe(event.error)}` : ""}`,
  ),
);
window.addEventListener("unhandledrejection", (event) =>
  logGameError(`Unhandled rejection: ${describe(event.reason)}`),
);
const consoleError = console.error;
console.error = function (...args: unknown[]) {
  logGameError(args.map(describe).join(" "));
  return consoleError.apply(this, args);
};
// RPGTL's runtime warns about files it can't load, which tells which file a game misses.
const consoleWarn = console.warn;
console.warn = function (...args: unknown[]) {
  if (typeof args[0] === "string" && args[0].startsWith("RPGTL: "))
    logGameError(args.map(describe).join(" "));
  return consoleWarn.apply(this, args);
};

const os = nodeRequire("os") as typeof import("node:os");
try {
  logStart(
    (text) => log("Start", text),
    nodeProcess.versions,
    `${os.version()} ${os.release()} ${nodeProcess.arch}`,
  );
} catch (error) {
  log("Start", `logging the start failed: ${describe(error)}`);
}

function showNotice() {
  if (!document.body) {
    if (!pending) {
      pending = true;
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          pending = false;
          showNotice();
        },
        { once: true },
      );
    }
    return;
  }
  if (!host) {
    host = document.createElement("div");
    host.style.cssText = "position:fixed;right:18px;top:18px;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      section { width:330px; max-width:calc(100vw - 76px); max-height:85vh; overflow:auto; padding:20px;
        background:#111c2ef5; color:#f4f7ff; border:1px solid #52627b; border-radius:14px;
        font:14px system-ui; box-shadow:0 12px 50px #0008; }
      h2 { margin:0 0 10px; font-size:18px; }
      p { white-space:pre-wrap; }
      button { float:right; font:inherit; background:#243248; color:#f4f7ff;
        border:1px solid #52627b; border-radius:6px; padding:7px; cursor:pointer; }
    </style><section role="alert"><button aria-label="Close notice">×</button><h2></h2><p></p></section>`;
    shadow.querySelector("button")!.addEventListener("click", () => {
      host!.hidden = true;
    });
    for (const type of ["keydown", "keyup", "mousedown", "touchstart", "wheel"])
      host.addEventListener(type, (event) => event.stopPropagation());
    document.body.append(host);
  }
  host.shadowRoot!.querySelector("h2")!.textContent = catalogError
    ? catalogHeading
    : changedHeading;
  host.shadowRoot!.querySelector("p")!.textContent = catalogError
    ? catalogText(catalogError)
    : changedText([...files].join(", "));
  host.hidden = false;
}

// The catalog's entries, image choices and translation switch, or undefined when there is none or
// it can't be read.
function readCatalog() {
  if (loaded) return loaded.catalog;
  loaded = { catalog: undefined };
  try {
    loaded.catalog = decodeCatalog(fs.readFileSync(rpgtl.catalog, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    catalogError = error instanceof Error ? error.message : String(error);
    log(catalogHeading, catalogText(catalogError));
    showNotice();
  }
  return loaded.catalog;
}

// The saved image reading, or undefined when there is none or it can't be read.
let cachedImages: { mtimeMs: number; size: number; results: ImageReadResults } | undefined;
function readImages() {
  try {
    const { mtimeMs, size } = fs.statSync(rpgtl.images);
    if (!cachedImages || cachedImages.mtimeMs !== mtimeMs || cachedImages.size !== size)
      cachedImages = {
        mtimeMs,
        size,
        results: decodeImages(fs.readFileSync(rpgtl.images, "utf8")),
      };
    return cachedImages.results;
  } catch (error) {
    cachedImages = undefined;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      log("RPGTL: image text could not be loaded", `${rpgtl.images}: ${describe(error)}`);
    return undefined;
  }
}

function changed(file: string) {
  if (files.has(file)) return;
  files.add(file);
  log(changedHeading, changedText(file));
  showNotice();
}

function listImages() {
  const img = path.join(path.dirname(rpgtl.data), "img");
  try {
    return fs
      .readdirSync(img, { recursive: true })
      .map((file) => `img/${String(file).split(path.sep).join("/")}`);
  } catch {
    return [];
  }
}

function translated(file: string, original: string) {
  const catalog = readCatalog();
  if (!catalog) return original;
  if (!catalog.translate) return original;
  try {
    const result = Result.flatMap(decodeGameFile(file, original), (data) =>
      applyTranslations(file, data, catalog.entries),
    ).pipe(
      Result.map((data) => {
        if (data._tag !== "System") return data;
        const results = readImages();
        return withSystemImages(data, {
          images: translatedImageNames(listImages(), catalog.entries),
          imageText: results
            ? imageTextHints(
                results,
                catalog,
                (erased) => nodeUrl.pathToFileURL(path.join(rpgtl.erased, erased)).href,
              )
            : undefined,
        });
      }),
    );
    if (Result.isSuccess(result)) return JSON.stringify(result.success.data);
  } catch {}
  changed(file);
  return original;
}

const decodePluginList = Schema.decodeUnknownResult(Plugins);

// js/plugins.js is a script that sets the global `$plugins`, so translate the list as it is set.
// The hook runs before any page script, and a `var` declaration keeps this setter.
let plugins: unknown;
Object.defineProperty(window, "$plugins", {
  configurable: true,
  get: () => plugins,
  set(value: unknown) {
    plugins = value;
    const catalog = readCatalog();
    if (!catalog?.translate || !Array.isArray(value)) return;
    const entries = catalog.entries;
    const result = Result.flatMap(decodePluginList(value), (list) =>
      applyPluginTranslations(list, entries),
    );
    if (Result.isSuccess(result)) plugins = result.success;
    else changed("plugins.js");
  },
});

// Windows games ask for files such as Img/Foo.PNG that are img/foo.png on disk.
const nodeFs = { existsSync: fs.existsSync, readdirSync: fs.readdirSync, join: path.join };
const fixed = new Map<string, string>();

function fixCase(input: string | URL): string | URL {
  const text = String(input);
  if (!/^(file:|[^:]*$)/i.test(text)) return input;
  const known = fixed.get(text);
  if (known !== undefined) return known;
  let result = text;
  try {
    const parsed = new URL(text, document.baseURI);
    if (parsed.protocol === "file:") {
      const file = nodeUrl.fileURLToPath(parsed.href);
      if (!fs.existsSync(file)) {
        const root = path.parse(file).root;
        const found = matchCase(root, path.relative(root, file).split(path.sep), nodeFs);
        if (found) {
          parsed.pathname = nodeUrl.pathToFileURL(path.join(root, ...found)).pathname;
          result = parsed.href;
        }
      }
    }
  } catch {}
  fixed.set(text, result);
  return result;
}

for (const [proto, property] of [
  [HTMLImageElement.prototype, "src"],
  [HTMLScriptElement.prototype, "src"],
  [HTMLMediaElement.prototype, "src"],
] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(proto, property);
  if (!descriptor?.set) continue;
  Object.defineProperty(proto, property, {
    ...descriptor,
    set(value: string) {
      descriptor.set!.call(this, fixCase(value));
    },
  });
}

const fetchUrl = window.fetch;
window.fetch = Object.assign(function (
  this: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  if (typeof input === "string" || input instanceof URL) input = fixCase(input);
  return fetchUrl.call(this, input, init);
}, fetchUrl);

const FontFaceOriginal = window.FontFace;
window.FontFace = new Proxy(FontFaceOriginal, {
  construct(target, [family, source, descriptors]) {
    if (typeof source === "string")
      source = source.replace(
        /url\((["']?)(.*?)\1\)/g,
        (_, quote, url) => `url(${quote}${fixCase(url)}${quote})`,
      );
    return new target(family, source, descriptors);
  },
});

const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
  const match = /(?:^|\/)data\/([^/?]+\.json)(?:\?[^]*)?$/i.exec(String(url));
  if (match) {
    const name = matchCase(rpgtl.data, [match[1]!], nodeFs)?.[0] ?? match[1]!;
    let original: string;
    try {
      // Node returns a file over about 1 MB as a string kept outside the page's memory, and NW.js
      // crashes when such a string goes into a Blob untranslated, so the page decodes the bytes.
      original = new TextDecoder().decode(fs.readFileSync(path.join(rpgtl.data, name)));
    } catch {
      return open.call(this, method, fixCase(url), ...(rest as [boolean, string?, string?]));
    }
    const blob = URL.createObjectURL(
      new Blob([translated(name, original)], { type: "application/json" }),
    );
    this.addEventListener("loadend", () => URL.revokeObjectURL(blob), {
      once: true,
    });
    url = blob;
  }
  return open.call(this, method, fixCase(url), ...(rest as [boolean, string?, string?]));
};
