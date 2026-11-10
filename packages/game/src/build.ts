import path from "node:path";
import { build } from "vite-plus";
import type { ScriptFile } from "./scripts.ts";

const scripts: Record<ScriptFile, { readonly entry: string; readonly minify: boolean }> = {
  "runtime.js": { entry: "runtime/index.ts", minify: false },
  "map-view.js": { entry: "mapView/index.ts", minify: false },
  "nwjs-hook.js": { entry: "nwjsHook/index.ts", minify: true },
};

/** Builds a game script with Vite into one self-contained file, with its fonts inlined. */
export async function buildScript(file: ScriptFile): Promise<string> {
  const { entry, minify } = scripts[file];
  const result = await build({
    configFile: false,
    root: import.meta.dirname,
    publicDir: false,
    logLevel: "silent",
    build: {
      write: false,
      minify,
      reportCompressedSize: false,
      assetsInlineLimit: () => true,
      lib: {
        entry: path.join(import.meta.dirname, entry),
        formats: ["iife"],
        name: "rpgtlBundle",
        fileName: () => "bundle.js",
      },
    },
  });
  const chunk = (Array.isArray(result) ? result : [result])
    .flatMap((item) => ("output" in item ? item.output : []))
    .find((output) => output.type === "chunk");
  if (chunk?.type !== "chunk") throw new Error(`Vite built no script for ${file}.`);
  return chunk.code;
}
