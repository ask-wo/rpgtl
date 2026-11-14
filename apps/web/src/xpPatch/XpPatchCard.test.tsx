import { page } from "vite-plus/test/browser";
import { expect, test } from "vite-plus/test";
import { GameContext } from "../games/GameContext.ts";
import { game } from "../testUtils/game.ts";
import { render, serveApi } from "../testUtils/fakeApi.tsx";
import { XpPatchCard } from "./XpPatchCard.tsx";

const unreadImage = {
  file: "Graphics/Pictures/Sign.png",
  sha256: "0",
  width: 4,
  height: 4,
  lines: [],
};

test("Unpack archive asks first, then turns into Undo unpack", async () => {
  let archive = "packed";
  const requests = serveApi((request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/xp/archive") return Response.json(archive);
    if (pathname === "/api/xp/unpack") {
      archive = "unpacked";
      return Response.json(archive);
    }
    return new Response(null, { status: 404 });
  });
  render(
    <GameContext value={{ ...game, engine: "XP" }}>
      <XpPatchCard />
    </GameContext>,
  );

  await page.getByRole("button", { name: "Unpack archive…" }).click();
  await expect.element(page.getByText("Unpack the game's archive?")).toBeVisible();
  expect(requests).not.toContain("POST /api/xp/unpack");
  await page.getByRole("button", { name: "Unpack", exact: true }).click();
  await expect.element(page.getByText("Unpacked the archive.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Undo unpack…" })).toBeVisible();
  expect(requests).toContain("POST /api/xp/unpack");
});

test("Export patch leaves the images out once Include images is unticked, which the browser keeps", async () => {
  const exported: Array<string | null> = [];
  serveApi((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/xp/archive") return Response.json("none");
    if (url.pathname === "/api/images")
      return Response.json({ version: 1, images: { "Graphics/Pictures/Sign": unreadImage } });
    if (url.pathname === "/api/xp/patch") {
      exported.push(url.searchParams.get("images"));
      return new Response(new Uint8Array([80, 75, 5, 6]), {
        headers: { "content-type": "application/zip" },
      });
    }
    return new Response(null, { status: 404 });
  });
  render(
    <GameContext value={{ ...game, engine: "XP" }}>
      <XpPatchCard />
    </GameContext>,
  );

  await page.getByRole("checkbox", { name: "Include images" }).click();
  await page.getByRole("button", { name: "Export patch" }).click();
  await expect.element(page.getByText("Exported the patch.")).toBeVisible();
  expect(exported).toEqual(["none"]);

  // A card rendered later, with atoms of its own, finds the box unticked.
  render(
    <GameContext value={{ ...game, engine: "XP" }}>
      <XpPatchCard />
    </GameContext>,
  );
  await expect
    .element(page.getByRole("checkbox", { name: "Include images" }).nth(1))
    .not.toBeChecked();
});
