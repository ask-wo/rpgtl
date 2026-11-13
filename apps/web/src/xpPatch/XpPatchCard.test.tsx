import { page } from "vite-plus/test/browser";
import { expect, test } from "vite-plus/test";
import { GameContext } from "../games/GameContext.ts";
import { game } from "../testUtils/game.ts";
import { render, serveApi } from "../testUtils/fakeApi.tsx";
import { XpPatchCard } from "./XpPatchCard.tsx";

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
