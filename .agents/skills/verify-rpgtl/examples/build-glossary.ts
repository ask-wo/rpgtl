// Build glossary on the Glossary page runs the real Ollama model on the fixture's names only: the
// bar says it is building the glossary, the glossary is locked meanwhile, and afterwards the page
// lists the terms the run added and takes edits again.
import { keepDatabase, savedCatalog } from "./saved.ts";

const barText = `(document.querySelector('[aria-label="Runs"]')?.textContent ?? "")`;

export default async ({ page, run, log }: any) => {
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  const id = (await page.eval("location.pathname")).slice("/games/".length);
  const saved = () => savedCatalog(run.state, id);

  await page.click('label[for="translate-game"]');
  await page.waitUntil(`${barText}.includes("text entries translated")`);
  await page.click('a[href$="/glossary"]');
  await page.waitUntil(`${barText}.includes("0 glossary terms")`);
  await page.waitUntil(`document.body.textContent.includes("No glossary terms yet.")`);
  await page.shot("empty");

  await page.clickText("Build glossary");
  await page.waitUntil(`${barText}.includes("Building the glossary")`, 60_000);
  log(`running bar: ${await page.eval(barText)}`);
  const locked = await page.eval(() =>
    ["Add term", "Remove glossary…"].map(
      (label) =>
        [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)
          ?.disabled,
    ),
  );
  if (locked.some((disabled: boolean | undefined) => !disabled))
    throw new Error(`the glossary isn't locked while the run goes: ${JSON.stringify(locked)}`);
  await page.shot("building");

  await page.waitUntil(`${barText}.includes("Glossary built")`, 600_000);
  log(`ended bar: ${await page.eval(barText)}`);
  const { glossary, entries } = saved();
  log(`glossary: ${JSON.stringify(glossary)}`);
  const guide = glossary.find((term: any) => term.source === "向导");
  if (!guide) throw new Error("the run didn't add 向导 to the glossary");
  if (entries.some((entry: any) => entry.source.startsWith("你好，旅行者") && entry.english))
    throw new Error("Build glossary translated dialogue");
  await page.waitUntil(`document.body.textContent.includes(${JSON.stringify(guide.english)})`);
  await page.shot("built");

  await page.eval(() =>
    (
      [...document.querySelectorAll('[aria-label="Glossary terms"] button')].find((row) =>
        row.textContent?.startsWith("向导"),
      ) as HTMLElement
    ).click(),
  );
  await page.waitUntil(`document.querySelector("#term-source")?.value === "向导"`);
  await page.fill("#term-translation", "Pathfinder");
  await page.waitUntil(`document.body.textContent.includes("All changes saved")`);
  for (let tries = 0; saved().glossary.every((t: any) => t.english !== "Pathfinder"); tries++) {
    if (tries > 50) throw new Error("the edit after the run wasn't saved");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  log("edited the built term after the run");
  await page.shot("edited");
  keepDatabase(run.state, id, run.evidence);
};
