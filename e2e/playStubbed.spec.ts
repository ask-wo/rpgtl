// The fixture game on the stubbed MV and MZ engines: RPGTL serves it with the runtime and the map
// view, and a translation edited on the Text page reaches its data files and shows in the map view.
// MZ has no public engine, so the stubs are all there is to play it on.
import { expect, test } from "./rpgtl.ts";

for (const engine of ["MV", "MZ"] as const)
  test(`an event name edited on the Text page shows in the ${engine} game's map view`, async ({
    page,
    openGame,
  }) => {
    const opened = await openGame(engine);
    await page.locator('label[for="translate-game"]').click();
    await page.locator('a[href$="/text"]').click();
    await page.getByRole("textbox", { name: "English for 客人1号" }).fill("Guest 1");
    await expect(page.getByText("All changes saved")).toBeVisible();

    const game = await opened.play();
    await game.waitForFunction("window.SceneManager && document.querySelector('#rpgtl-map-view')");
    // The stub's map is part of its script, so it gets the served file's names as the engine's
    // DataManager would.
    await game.evaluate(
      'fetch("data/Map001.json").then((r) => r.json()).then((map) => ($dataMap.rpgtlNames = map.rpgtlNames))',
    );
    await game.keyboard.press("F7");
    const view = game.locator("#rpgtl-map-view");
    await expect(view).toBeVisible();
    await expect(view.locator('#events button[data-id="1"]')).toContainText("Guest 1");
    await game.keyboard.press("F7");
    await expect(view).toBeHidden();

    await game.keyboard.press("F8");
    await expect(game.getByRole("heading", { name: "RPGTL game controls" })).toBeVisible();
  });
