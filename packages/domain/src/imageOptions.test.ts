import { assert, it } from "@effect/vitest";
import type { Catalog } from "@rpgtl/contracts";
import { withImageOptions } from "./index.ts";

const catalog: Catalog = {
  version: 1,
  game: { id: "g", title: "G", engine: "MZ" },
  entries: [],
  glossary: [],
  translate: true,
  imageBold: "always",
  unchangedImages: ["img/pictures/Logo"],
};

it("changes only the image choices it is given", () => {
  const saved = withImageOptions(catalog, { imageFont: "serif" });
  assert.deepStrictEqual(saved, { ...catalog, imageFont: "serif" });
});

it("null and empty choices remove what was saved", () => {
  const saved = withImageOptions(catalog, { imageBold: null, unchangedImages: [] });
  assert.deepStrictEqual(saved, {
    version: 1,
    game: catalog.game,
    entries: [],
    glossary: [],
    translate: true,
  });
});

it("keeps an image once, however often the page lists it", () => {
  const saved = withImageOptions(catalog, { unchangedImages: ["img/a", "img/a", "img/b"] });
  assert.deepStrictEqual(saved.unchangedImages, ["img/a", "img/b"]);
});
