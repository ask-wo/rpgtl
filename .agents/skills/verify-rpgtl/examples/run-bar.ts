// The run bar: Translate runs the real Ollama model on the fixture's Chinese lines, the bar and
// the Translation card follow the run live (also after a reload) and lock the card meanwhile, and
// Stop ends a second run keeping what it saved.
import { copyFileSync, readFileSync } from "node:fs";
import { entryTranslation } from "../../../../packages/domain/src/guesses.ts";

const barText = `(document.querySelector('[aria-label="Runs"]')?.textContent ?? "")`;
const translated = (catalog: any) =>
  catalog.entries.filter((entry: any) => entryTranslation(entry) && /[一-鿿]/.test(entry.source));

export default async ({ page, run, log }: any) => {
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  const id = (await page.eval("location.pathname")).slice("/games/".length);
  const saved = () => JSON.parse(readFileSync(`${run.state}/games/${id}/catalog.json`, "utf8"));

  await page.waitUntil(`document.body.textContent.includes("Switch on to translate")`);
  if (await page.eval(`!!document.querySelector('[aria-label="Runs"]')`))
    throw new Error("the run bar shows while the translation is off");
  await page.click('label[for="translate-game"]');
  await page.waitUntil(`${barText}.includes("text entries translated")`);
  const idle = await page.eval(barText);
  log(`idle bar: ${idle}`);
  await page.shot("idle");

  await page.clickText("Translate");
  await page.waitUntil(`${barText}.includes("Translating") || ${barText}.includes("Stop")`, 60_000);
  log(`running bar: ${await page.eval(barText)}`);
  const locked = await page.eval(() => ({
    switch: (document.querySelector("#translate-game") as HTMLInputElement | null)?.disabled,
    import: [...document.querySelectorAll("button")].find((b) => b.textContent === "Import…")
      ?.disabled,
    clear: [...document.querySelectorAll("button")].find((b) => b.textContent === "Clear all…")
      ?.disabled,
    settings: document.body.textContent?.includes(
      "A run is going: stop it to change these settings.",
    ),
    inert: !!document.querySelector("[inert]"),
  }));
  log(`card while running: ${JSON.stringify(locked)}`);
  if (!locked.switch || !locked.import || !locked.clear || !locked.settings || !locked.inert)
    throw new Error("the card isn't locked while the run goes");
  await page.shot("running");

  await page.goto(`/games/${id}`);
  await page.waitUntil(
    `${barText}.includes("Stop") || ${barText}.includes("Translation done")`,
    30_000,
  );
  log(`after reload: ${await page.eval(barText)}`);
  await page.shot("running-after-reload");

  await page.waitUntil(`${barText}.includes("Translation done")`, 600_000);
  const done = await page.eval(barText);
  log(`ended bar: ${done}`);
  const after = saved();
  const chinese = translated(after);
  log(
    `translated Chinese lines: ${JSON.stringify(chinese.map((e: any) => [e.source, entryTranslation(e)]))}`,
  );
  if (chinese.length === 0) throw new Error("the run saved no translation");
  const counts = await page.eval(
    `document.body.textContent.match(/(\\d+) of (\\d+) text entries translated/g)`,
  );
  log(`counts on the page without a reload: ${JSON.stringify(counts)}`);
  await page.shot("done");
  copyFileSync(`${run.state}/games/${id}/catalog.json`, `${run.evidence}/catalog-after-run.json`);

  await page.clickText("Clear all…");
  await page.clickText("Clear all translations");
  await page.waitUntil(`document.body.textContent.includes("Cleared all translations")`);
  await page.waitUntil(`${barText}.includes("0 of 28 text entries translated")`);
  // A click while the dialog closes lands on its backdrop.
  await page.waitUntil(`!document.querySelector('[role="alertdialog"]')`);
  await page.clickText("Translate");
  try {
    await page.waitUntil(`${barText}.includes("Stop")`, 60_000);
  } catch (error) {
    log(`bar instead: ${await page.eval(barText)}`);
    await page.shot("no-second-run");
    throw error;
  }
  await page.clickText("Stop");
  await page.waitUntil(`${barText}.includes("Translation stopped")`, 120_000);
  log(`stopped bar: ${await page.eval(barText)}`);
  await page.shot("stopped");
  const enabled = await page.eval(
    () =>
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Import…")
        ?.disabled === false,
  );
  if (!enabled) throw new Error("Import… stays locked after the run");
  copyFileSync(`${run.state}/games/${id}/catalog.json`, `${run.evidence}/catalog-after-stop.json`);
};
