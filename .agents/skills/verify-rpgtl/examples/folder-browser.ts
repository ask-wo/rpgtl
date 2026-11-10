export default async ({ page, run, log }: any) => {
  const parent = run.game.slice(0, run.game.lastIndexOf("/"));
  await page.waitFor("#game-path");
  await page.clickText("Choose folder…");
  await page.waitFor('input[name="path"]');
  await page.fill('input[name="path"]', `${run.game}/data`);
  await page.clickText("Go");
  await page.waitUntil(
    `document.querySelector('input[name="path"]')?.value === ${JSON.stringify(`${run.game}/data`)}`,
  );
  await page.shot("inside-data");
  await page.clickText("Up");
  await page.waitUntil(
    `document.querySelector('input[name="path"]')?.value === ${JSON.stringify(run.game)}`,
  );
  log(
    `after one Up: ${await page.eval(() => (document.querySelector('input[name="path"]') as HTMLInputElement).value)}`,
  );
  await page.clickText("Up");
  await page.waitUntil(
    `document.querySelector('input[name="path"]')?.value === ${JSON.stringify(parent)}`,
  );
  await page.waitUntil(
    `[...document.querySelectorAll('[aria-label="Folders"] button')].some((b) => b.textContent === "gameGame")`,
  );
  await page.shot("run-folder-with-game-marked");
  log(
    `listed: ${await page.eval(() => [...document.querySelectorAll('[aria-label="Folders"] button')].map((b) => b.textContent).join(", "))}`,
  );
  await page.eval(() =>
    (
      [...document.querySelectorAll('[aria-label="Folders"] button')].find(
        (b) => b.textContent === "gameGame",
      ) as HTMLElement
    ).click(),
  );
  await page.waitUntil(
    `document.querySelector('input[name="path"]')?.value === ${JSON.stringify(run.game)}`,
  );
  await page.clickText("Choose this folder");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  await page.shot("opened");
};
