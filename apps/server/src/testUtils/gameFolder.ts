import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** An MV game below `www/`, with a dialogue line, a plugin setting and a face it doesn't have. */
export const mvGame: Record<string, string> = {
  "Game.exe": "",
  "www/index.html": '<script src="js/rpg_core.js"></script><script src="js/main.js"></script>',
  "www/js/rpg_core.js": "",
  "www/js/rmmz_core.js": "// an unused MZ core",
  "www/js/plugins.js": `var $plugins = ${JSON.stringify([
    { name: "Pic", status: true, parameters: { title: "标题", sound: "合成物品" } },
  ])};`,
  "www/data/System.json": JSON.stringify({ gameTitle: "雨", switches: ["", "门开了"] }),
  "www/data/Map001.json": JSON.stringify({
    events: [
      null,
      {
        id: 1,
        name: "",
        pages: [
          {
            list: [
              { code: 101, parameters: ["$Arlene", 2, 0, 2] },
              { code: 401, parameters: ["你好"] },
              { code: 231, parameters: [1, "title"] },
            ],
          },
        ],
      },
    ],
  }),
  "www/img/faces/Actor1.png": "",
  "www/img/pictures/Title.png": "",
  "www/audio/se/合成物品.ogg": "",
  "www/movies/Op.mp4": "",
};

/** Writes `files` below a new folder removed when the test ends, and gives the folder. */
export const folderWith = Effect.fnUntraced(function* (files: Record<string, string | Uint8Array>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  for (const [name, text] of Object.entries(files)) {
    yield* fs.makeDirectory(path.dirname(path.join(dir, name)), { recursive: true });
    yield* typeof text === "string"
      ? fs.writeFileString(path.join(dir, name), text)
      : fs.writeFile(path.join(dir, name), text);
  }
  return dir;
});
