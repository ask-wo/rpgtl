// The Glossary page: a changed term saves itself and renames the entries that are exactly it, a
// new term saves once it has an original, clearing a term's mismatches backs up first, a kind
// saves at once, the page keeps its terms over a reload, and Remove glossary… asks first.
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { entryTranslation, termTranslation } from "../../../../packages/domain/src/guesses.ts";

const until = async (what: string, check: () => boolean) => {
  for (let tries = 0; tries < 50; tries++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what} didn't happen`);
};

export default async ({ page, api, run, log }: any) => {
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
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  const id = (await page.eval("location.pathname")).slice("/games/".length);
  const saved = () => JSON.parse(readFileSync(`${run.state}/games/${id}/catalog.json`, "utf8"));
  const backups = () => readdirSync(`${run.state}/games/${id}/backups`).length;

  await page.click('label[for="translate-game"]');
  await page.waitUntil(`document.body.textContent.includes("text entries translated")`);
  const catalog = await api(`catalog?id=${id}`);
  const file = {
    ...catalog,
    entries: catalog.entries.map((entry: any) =>
      entry.source === "向导"
        ? { ...entry, translation: { user: "Guide" } }
        : entry.source.startsWith("你好，旅行者")
          ? { ...entry, translation: { user: "Hello, traveller. Welcome to the woods." } }
          : entry,
    ),
    glossary: [
      { source: "向导", translation: { user: "Guide" }, kind: { guess: { value: "character" } } },
    ],
  };
  const importFile = `${run.dir}/import.json`;
  writeFileSync(importFile, JSON.stringify(file));
  await importThrough(importFile);

  await page.click('a[href$="/glossary"]');
  await page.waitFor("#term-translation");
  await page.waitUntil(
    `document.querySelector('[aria-label="Runs"]')?.textContent.includes("1 glossary term")`,
  );
  await page.shot("glossary");

  await page.fill("#term-translation", "Leader");
  await until(
    "the renamed term's save",
    () => termTranslation(saved().glossary[0] ?? { translation: {} }) === "Leader",
  );
  const speakers = saved().entries.filter((entry: any) => entry.source === "向导");
  if (speakers.some((entry: any) => entryTranslation(entry) !== "Leader"))
    throw new Error("the speaker entries didn't follow the renamed term");
  await page.waitUntil(`document.body.textContent.includes("All changes saved")`);
  log(`renamed: ${speakers.length} speaker entries read Leader; backups ${backups()}`);
  await page.shot("renamed");

  await page.clickText("Add term");
  await page.waitFor("#term-source");
  await page.fill("#term-source", "森林");
  await page.fill("#term-translation", "Forest");
  await page.click('[aria-label="Filter terms"]');
  await until("the new term's save", () =>
    saved().glossary.some(
      (term: any) => term.source === "森林" && termTranslation(term) === "Forest",
    ),
  );
  log(`added: ${JSON.stringify(saved().glossary)}`);

  const before = backups();
  await page.clickText("Clear wrong text");
  await page.waitUntil(
    `document.body.textContent.includes("Cleared 1 translation of 森林 that didn't use Forest.")`,
  );
  const welcome = saved().entries.find((entry: any) => entry.source.startsWith("你好，旅行者"));
  if (
    entryTranslation(welcome) !== "" ||
    welcome.previous !== "Hello, traveller. Welcome to the woods."
  )
    throw new Error(`the mismatch wasn't cleared: ${JSON.stringify(welcome)}`);
  if (backups() !== before + 1) throw new Error("clearing made no backup");
  log("cleared the line that says woods, kept as previous; one more backup");
  await page.shot("cleared");

  await page.click("#term-kind");
  await page.waitFor('[role="option"]');
  await page.eval(() =>
    (
      [...document.querySelectorAll('[role="option"]')].find(
        (option) => option.textContent === "Word",
      ) as HTMLElement
    ).click(),
  );
  await until("the kind's save", () =>
    saved().glossary.some((term: any) => term.source === "森林" && term.kind.user === "word"),
  );
  log(`kind: ${JSON.stringify(saved().glossary.find((term: any) => term.source === "森林"))}`);

  await page.goto(await page.eval("location.pathname"));
  await page.waitUntil(`document.body.textContent.includes("Words · 1")`);
  await page.shot("reloaded");

  await page.clickText("Remove glossary…");
  await page.waitUntil(`document.body.textContent.includes("Remove the glossary?")`);
  await page.shot("remove-all-asks");
  await page.clickText("Remove glossary");
  await until("Remove all's save", () => saved().glossary.length === 0);
  await page.waitUntil(`document.body.textContent.includes("No glossary terms yet.")`);
  log("removed all terms");
  await page.shot("removed");
  copyFileSync(`${run.state}/games/${id}/catalog.json`, `${run.evidence}/catalog.json`);
};
