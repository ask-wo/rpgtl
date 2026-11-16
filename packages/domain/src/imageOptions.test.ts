import { assert, it } from "@effect/vitest";
import { withImageOptions } from "./index.ts";
import { testCatalog } from "./testUtils/catalog.ts";

const catalog = testCatalog({
  settings: { letteringWeight: "bold", untranslatedImages: ["img/pictures/Logo"] },
});

it("changes only the image choices it is given", () => {
  const saved = withImageOptions(catalog, { letteringFont: "serif" });
  assert.deepStrictEqual(saved.settings, { ...catalog.settings, letteringFont: "serif" });
});

it("null and empty choices remove what was saved", () => {
  const saved = withImageOptions(catalog, { letteringWeight: null, untranslatedImages: [] });
  assert.deepStrictEqual(saved.settings, testCatalog().settings);
});

it("keeps an image once, however often the page lists it", () => {
  const saved = withImageOptions(catalog, { untranslatedImages: ["img/a", "img/a", "img/b"] });
  assert.deepStrictEqual(saved.settings.untranslatedImages, ["img/a", "img/b"]);
});
