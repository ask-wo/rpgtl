// The Translation card's Game language: the guess from the text, a chosen language saved in the
// game's settings, and going back to the language the text looks like.
import { writeFileSync } from "node:fs";
import { savedCatalog } from "./saved.ts";

export default async ({ page, run, log }: any) => {
  await page.fill("#game-path", run.game);
  await page.clickText("Open");
  await page.waitUntil(`document.querySelector("h1")?.textContent === "Fixture Adventure"`);
  const id = (await page.eval("location.pathname")).slice("/games/".length);
  const saved = () => savedCatalog(run.state, id).settings;
  const shown = () => page.text("#game-language");
  // Where the Translation card is in each screenshot, for cropping them to it.
  const cards: Record<string, unknown> = {};
  const measure = () =>
    page.eval(() => {
      const card = document.querySelector("#game-language")!.closest('[data-slot="card"]')!;
      const { x, y, width } = card.getBoundingClientRect();
      return { x, y, width };
    });
  const shot = async (name: string) => {
    cards[name] = await measure();
    await page.shot(name);
  };

  await page.click('label[for="translate-game"]');
  await page.waitFor("#game-language");
  log(`shown: ${await shown()}; saved language: ${saved().sourceLanguage}`);
  if ((await shown()) !== "Chinese (Automatic)") throw new Error("no guess shown");
  await shot("guessed");

  // page.click scrolls the select to the middle before opening it; doing it first keeps the card
  // where it is measured.
  await page.eval(() =>
    document.querySelector("#game-language")!.scrollIntoView({ block: "center" }),
  );
  cards.choices = await measure();
  await page.click("#game-language");
  await page.waitFor('[role="option"]');
  // page.shot captures beyond the window, which resizes the page and closes the list.
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${run.evidence}/choices.png`, Buffer.from(data, "base64"));
  await page.press("Escape");

  await page.select("#game-language", "Korean");
  await page.waitUntil(`document.querySelector("#game-language")?.textContent === "Korean"`);
  log(`shown: ${await shown()}; saved language: ${saved().sourceLanguage}`);
  if (saved().sourceLanguage !== "korean") throw new Error("Korean wasn't saved");
  await shot("korean-chosen");

  await page.select("#game-language", "Chinese (Automatic)");
  await page.waitUntil(
    `document.querySelector("#game-language")?.textContent === "Chinese (Automatic)"`,
  );
  log(`shown: ${await shown()}; saved language: ${saved().sourceLanguage}`);
  if ("sourceLanguage" in saved()) throw new Error("the choice wasn't removed");
  writeFileSync(`${run.evidence}/cards.json`, JSON.stringify(cards));
};
