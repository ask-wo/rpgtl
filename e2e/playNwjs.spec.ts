// Play starts the real-MV game in NW.js, which has no remote debugging, so a plugin added to the
// game reports what it sees to a file and quits NW.js.
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./rpgtl.ts";

const probe = (report: string) => `(function () {
  var start = Scene_Title.prototype.start;
  Scene_Title.prototype.start = function () {
    start.call(this);
    DataManager.setupNewGame();
    var report = {
      commands: this._commandWindow._list.map(function (command) { return command.name; }),
      saved: DataManager.saveGame(1),
      // Plugins read their own files by paths relative to the working folder.
      read: require("fs").readFileSync("js/plugins/Probe.js", "utf8").length > 0,
    };
    require("fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify(report));
    nw.App.quit();
  };
})();
`;

/** A plugin that writes `file` once the title screen starts. */
const titleMark = (file: string) => `(function () {
  var start = Scene_Title.prototype.start;
  Scene_Title.prototype.start = function () {
    start.call(this);
    require("fs").writeFileSync(${JSON.stringify(file)}, "");
  };
})();
`;

test("Play starts the game in NW.js with its translations, it saves into the game's folder, and Stop ends it", async ({
  page,
  openGame,
  rpgtl,
}, testInfo) => {
  const opened = await openGame("real-MV");
  const root = testInfo.outputPath("game");
  const report = testInfo.outputPath("report.json");
  await writeFile(path.join(root, "js", "plugins", "Probe.js"), probe(report));
  await appendFile(
    path.join(root, "js", "plugins.js"),
    '$plugins.push({ name: "Probe", status: true, description: "", parameters: {} });\n',
  );

  await page.locator('label[for="translate-game"]').click();
  await page.locator('a[href$="/text"]').click();
  await page
    .getByRole("navigation", { name: "Text files" })
    .getByRole("button", { name: /^Plugins \d/ })
    .click();
  await page.getByRole("textbox", { name: "English for 致谢" }).fill("Thanks");
  await expect(page.getByText("All changes saved")).toBeVisible();

  await page.goto(new URL(`/games/${opened.id}`, page.url()).href);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const download = page.getByRole("button", { name: "Download and play" });
  // NW.js is downloaded once into ~/.cache/rpgtl/nwjs/; CI restores it from its cache or fetches it ahead with `pnpm run download-nwjs`.
  await expect(download.or(page.getByText(/^(Running in NW\.js|NW\.js exited)/))).toBeVisible();
  if (await download.isVisible()) await download.click();
  await expect(page.getByText("NW.js exited with exit code 0.")).toBeVisible({ timeout: 90_000 });

  expect(JSON.parse(await readFile(report, "utf8"))).toEqual({
    commands: ["New Game", "Continue", "Options", "Thanks"],
    saved: true,
    read: true,
  });
  expect((await stat(path.join(root, "save", "file1.rpgsave"))).isFile()).toBe(true);
  const log = await readFile(
    path.join(rpgtl.state, "games", opened.id, "logs", "nwjs.log"),
    "utf8",
  );
  expect(log).toMatch(/^Start: hook started in NW\.js \d/m);
  expect(log).toMatch(/^Start: page loaded, /m);

  const titled = testInfo.outputPath("titled");
  await writeFile(path.join(root, "js", "plugins", "Probe.js"), titleMark(titled));
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByText("Running in NW.js")).toBeVisible();
  // NW.js exits with code 0 on a signal once its page has loaded, which is the usual case.
  await expect
    .poll(
      () =>
        stat(titled).then(
          () => true,
          () => false,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("NW.js was stopped.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
});
