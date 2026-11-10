import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Catalog, Engine } from "@rpgtl/contracts";
import { decodeGameFile, decodePlugins, gameEntries } from "@rpgtl/domain";
import { Result } from "effect";

const readOr = (file: string, fallback: string) => readFile(file, "utf8").catch(() => fallback);

/** A new catalog of the game at `webRoot`. */
export async function fixtureCatalog(webRoot: string, engine: Engine): Promise<Catalog> {
  const plugins = Result.getOrThrow(
    decodePlugins(await readOr(path.join(webRoot, "js", "plugins.js"), "[]")),
  );
  const pluginCode = new Map<string, string>();
  for (const plugin of plugins)
    if (plugin)
      pluginCode.set(
        plugin.name,
        await readOr(path.join(webRoot, "js", "plugins", `${plugin.name}.js`), ""),
      );
  const assets = [];
  for (const folder of ["img", "audio", "movies"])
    for (const file of await readdir(path.join(webRoot, folder), {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []))
      if (file.isFile())
        assets.push(
          path.relative(webRoot, path.join(file.parentPath, file.name)).split(path.sep).join("/"),
        );
  const dataFiles = [];
  for (const name of (await readdir(path.join(webRoot, "data"))).toSorted()) {
    if (!name.endsWith(".json")) continue;
    const text = await readFile(path.join(webRoot, "data", name), "utf8");
    dataFiles.push({ name, data: Result.getOrThrow(decodeGameFile(name, text)) });
  }
  const entries = gameEntries({ plugins, pluginCode, assets, dataFiles });
  return {
    version: 1,
    game: { id: "fixture", title: "Fixture", engine },
    translate: true,
    entries,
    glossary: [],
  };
}
