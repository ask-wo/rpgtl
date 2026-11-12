// The Text page: typed English saves itself without a backup and reaches the game's data, an edit
// without its control codes is refused and not written, the tree, search and filters narrow the
// list and stay over a reload, and Flagged shows a check's note.
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { entryTranslation } from "../../../../packages/domain/src/guesses.ts";

const until = async (what: string, check: () => boolean) => {
  for (let tries = 0; tries < 50; tries++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what} didn't happen`);
};

const sword = "这把剑很重，你要小心。";

export default async ({ page, api, run, log }: any) => {
  const box = (source: string) => page.labelled(`English for ${source}`, "textarea");
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  const id = (await page.eval("location.pathname")).slice("/games/".length);
  const saved = () => JSON.parse(readFileSync(`${run.state}/games/${id}/catalog.json`, "utf8"));
  const translation = (source: string) =>
    entryTranslation(saved().entries.find((each: any) => each.source === source));
  const backups = () =>
    existsSync(`${run.state}/games/${id}/backups`)
      ? readdirSync(`${run.state}/games/${id}/backups`).length
      : 0;

  await page.click('label[for="translate-game"]');
  await page.waitFor('a[href$="/text"]');
  await page.click('a[href$="/text"]');
  await page.waitFor(box(sword));
  await page.shot("text");

  const before = backups();
  await page.fill(box(sword), "This sword is heavy, so be careful.");
  await until(
    "the typed English's save",
    () => translation(sword) === "This sword is heavy, so be careful.",
  );
  await page.waitUntil(`document.body.textContent.includes("All changes saved")`);
  if (backups() !== before) throw new Error("saving an edit made a backup");
  const served = await (await fetch(`${run.url}/game/${id}/data/CommonEvents.json`)).text();
  if (!served.includes("This sword is heavy")) throw new Error("the game isn't served the edit");
  log("typed English saved without a backup and served in CommonEvents.json");
  await page.shot("saved");

  await page.fill(box("Recover \\V[1] HP."), "Recover HP.");
  await page.waitUntil(
    `document.body.textContent.includes("Keep the original's RPG Maker control codes")`,
  );
  if (translation("Recover \\V[1] HP.") !== "")
    throw new Error("the edit without its control code was written");
  log("an edit without \\V[1] was refused and not written");
  await page.shot("refused");
  await page.fill(box("Recover \\V[1] HP."), "Recover \\V[1] HP back.");
  await until(
    "the fixed English's save",
    () => translation("Recover \\V[1] HP.") === "Recover \\V[1] HP back.",
  );

  await page.clickText(/^Items/, 'nav[aria-label="Text files"]');
  await page.waitUntil(`location.search === "?place=items"`);
  await page.fill('[aria-label="Search the text"]', "potion");
  await page.waitUntil(`new URLSearchParams(location.search).get("q") === "potion"`);
  await page.clickText(/^Untranslated/);
  await page.waitUntil(`new URLSearchParams(location.search).get("show") === "untranslated"`);
  const shown = () =>
    page.eval(() =>
      [...document.querySelectorAll('[aria-label="Entries"] textarea')].map((field) => [
        field.getAttribute("aria-label"),
        (field as HTMLTextAreaElement).value,
      ]),
    );
  const narrowed = await shown();
  log(`narrowed to ${await page.eval("location.search")}: ${JSON.stringify(narrowed)}`);
  if (narrowed.some(([, value]: [string, string]) => value !== ""))
    throw new Error("Untranslated lists a translated entry");
  await page.shot("narrowed");
  await page.goto(`/games/${id}/text?place=items&q=potion&show=untranslated`);
  await page.waitUntil(
    `document.querySelector('[aria-label="Search the text"]')?.value === "potion"`,
  );
  await page.waitUntil(
    `document.querySelector('nav[aria-label="Text files"] [aria-current]')?.textContent.startsWith("Items")`,
  );
  if (JSON.stringify(await shown()) !== JSON.stringify(narrowed))
    throw new Error("the reload lists other entries");
  log("the reload keeps the file, search and filter");
  await page.shot("reloaded");

  await page.goto(`/games/${id}/text`);
  await page.fill(box(sword), "This sword 很重, so be careful.");
  await until(
    "the English with Chinese left's save",
    () => translation(sword) === "This sword 很重, so be careful.",
  );
  await page.click('[aria-label="Search the text"]');
  await page.waitUntil(
    `[...document.querySelectorAll("button")].some((b) => b.textContent === "Flagged1")`,
  );
  await page.clickText("Flagged1");
  await page.waitUntil(
    `document.body.textContent.includes("Check: Chinese left. Editing the English clears this.")`,
  );
  log(`checks: ${JSON.stringify(await api(`checks?id=${id}`))}`);
  await page.shot("flagged");
  copyFileSync(`${run.state}/games/${id}/catalog.json`, `${run.evidence}/catalog.json`);
};
