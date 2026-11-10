// The overview's Translation card: the switch decides what the browser game is served, Import…
// takes a translation file, Clear all… asks first and backs up, and the translator settings save.
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { entryTranslation } from "../../../../packages/domain/src/guesses.ts";

const english = "Hello, traveller. Welcome to the forest.";

export default async ({ page, api, run, log }: any) => {
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  const id = (await page.eval("location.pathname")).slice("/games/".length);
  const served = () =>
    page.eval(
      async (game: string) => (await fetch(`/game/${game}/data/CommonEvents.json`)).text(),
      id,
    );
  const saved = () => JSON.parse(readFileSync(`${run.state}/games/${id}/catalog.json`, "utf8"));
  const backups = () => readdirSync(`${run.state}/games/${id}/backups`).length;
  // Import… asks first; its dialog still covers the page for a moment after it closes.
  const importThrough = async (path: string) => {
    await page.send("DOM.enable");
    const { result } = await page.send("Runtime.evaluate", {
      expression: `document.querySelector('input[type="file"]')`,
    });
    await page.send("DOM.setFileInputFiles", { files: [path], objectId: result.objectId });
    await page.waitUntil(`document.body.textContent.includes("Import import.json?")`);
    const preview = await page.eval(
      () => document.querySelector('[role="alertdialog"] ul')?.textContent,
    );
    await page.shot("import-preview");
    await page.eval(() =>
      (
        [...document.querySelectorAll('[role="alertdialog"] button')].find(
          (button) => button.textContent === "Import",
        ) as HTMLElement
      ).click(),
    );
    await page.waitUntil(`document.body.textContent.includes("Imported, after backing up")`);
    await page.waitUntil(`!document.querySelector('[data-slot="alert-dialog-overlay"]')`);
    return preview;
  };

  await page.waitUntil(`document.body.textContent.includes("Switch on to translate or import.")`);
  if (await page.eval(`!!document.querySelector('input[type="file"]')`))
    throw new Error("Import is offered while the switch is off");
  await page.shot("off-new-game");

  await page.click('label[for="translate-game"]');
  await page.waitUntil(`document.body.textContent.includes("text entries translated")`);
  if (saved().translate !== true) throw new Error("the switch wasn't saved as on");
  log(`catalog translate: ${saved().translate}`);
  await page.waitFor("#translator");
  await page.shot("on");

  const catalog = await api(`catalog?id=${id}`);
  const file = {
    ...catalog,
    entries: catalog.entries.map((entry: any) =>
      entry.source.startsWith("你好，旅行者")
        ? { ...entry, translation: { user: english } }
        : entry,
    ),
  };
  const importFile = `${run.dir}/import.json`;
  writeFileSync(importFile, JSON.stringify(file));
  log(`import preview: ${await importThrough(importFile)}`);
  if (!(await served()).includes(english)) throw new Error("the import isn't served to the game");
  log(`imported; backups: ${backups()}; served CommonEvents.json has the English`);
  await page.shot("imported");

  await page.click("#translator");
  await page.waitFor('[role="option"]');
  await page.eval(() =>
    (
      [...document.querySelectorAll('[role="option"]')].find((option) =>
        option.textContent?.startsWith("Claude"),
      ) as HTMLElement
    ).click(),
  );
  await page.waitUntil(`document.body.textContent.includes("Sends the game's text to Anthropic")`);
  const settings = readFileSync(`${run.dir}/config/rpgtl/settings.json`, "utf8");
  log(`settings.json: ${settings}`);
  if (!/"translator": ?"claude"/.test(settings)) throw new Error("the translator wasn't saved");
  await page.shot("claude");

  const before = backups();
  await page.clickText("Clear all…");
  await page.waitUntil(`document.body.textContent.includes("Clear all translations?")`);
  await page.shot("clear-asks");
  await page.clickText("Clear all translations");
  await page.waitUntil(`document.body.textContent.includes("Cleared all translations")`);
  const cleared = saved();
  if (cleared.entries.some((entry: any) => entryTranslation(entry)))
    throw new Error("a translation is left");
  if (cleared.translate !== true) throw new Error("Clear all turned the switch off");
  if (backups() !== before + 1) throw new Error("Clear all made no backup");
  log("cleared, switch still on, one more backup");
  await page.shot("cleared");

  await importThrough(importFile);
  await page.click('label[for="translate-game"]');
  await page.waitUntil(
    `document.body.textContent.includes("Off: the game plays its original text. 1 translation is kept.")`,
  );
  const original = await served();
  if (original.includes(english) || !original.includes("你好，旅行者"))
    throw new Error("the game is still served translated with the switch off");
  if (saved().entries.every((entry: any) => !entryTranslation(entry)))
    throw new Error("switching off dropped the translation");
  log("switched off: served CommonEvents.json is the original, the translation is kept");
  await page.shot("off-kept");
  copyFileSync(`${run.state}/games/${id}/catalog.json`, `${run.evidence}/catalog.json`);
};
