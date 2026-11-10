// One game's run goes and another's waits for it, without a model: Ollama's endpoint is a local
// server that never answers, so the first run stays at its start. Two copies of the fixture
// translate with that local model, and the second waits. Shows the bar's waiting text, the
// sidebar's marks (spinner, hourglass) and what the waiting game's row says on hover.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const barText = `(document.querySelector('[aria-label="Runs"]')?.textContent ?? "")`;

export default async ({ page, api, run, log }: any) => {
  const silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(silent.address() as { port: number }).port}`;
  const settings = await api("settings");
  await api("settings", { ...settings, ollama: { ...settings.ollama, endpoint } });

  const second = path.join(path.dirname(run.game), "second-game");
  cpSync(run.game, second, { recursive: true });
  const system = path.join(second, "data", "System.json");
  writeFileSync(
    system,
    readFileSync(system, "utf8").replace('"Fixture Adventure"', '"Harbor Lights"'),
  );

  const translate = async (folder: string, title: string) => {
    await page.goto("/");
    await page.fill("#game-path", folder);
    await page.clickText("Open");
    await page.waitUntil(`document.querySelector("h1")?.textContent === ${JSON.stringify(title)}`);
    await page.click('label[for="translate-game"]');
    await page.waitUntil(`${barText}.includes("text entries translated")`);
    await page.clickText("Translate");
  };
  await translate(run.game, "Fixture Adventure");
  await page.waitUntil(`${barText}.includes("Stop")`);
  await translate(second, "Harbor Lights");
  await page.waitUntil(
    `${barText}.includes("It starts once translation in Fixture Adventure has finished.")`,
  );
  await page.waitFor('[role="status"][aria-label="Translating"]');
  await page.waitFor(
    '[role="img"][aria-label="Translation waits for translation in Fixture Adventure"]',
  );
  await page.shot("waiting", '[data-sidebar="sidebar"]');

  const box = await page.eval((root: string) => {
    const r = document.querySelector(`[data-game-root="${root}"]`)!.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, second);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await page.waitUntil(
    `document.body.textContent.includes("Translation waits for translation in Fixture Adventure")`,
  );
  await page.shot("waiting-details");
  log("the second game waits for the first, and the sidebar marks both");

  await page.clickText("Stop");
  await page.waitUntil(`${barText}.includes("Translation stopped")`);
  silent.close();
};
