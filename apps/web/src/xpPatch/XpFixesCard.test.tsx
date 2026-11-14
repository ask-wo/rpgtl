import { page } from "vite-plus/test/browser";
import { expect, test } from "vite-plus/test";
import { GameContext } from "../games/GameContext.ts";
import { game } from "../testUtils/game.ts";
import { render, serveApi } from "../testUtils/fakeApi.tsx";
import { XpFixesCard } from "./XpFixesCard.tsx";

const fix = { name: "slow-door.rb", description: "Doors: open at once", on: true };

const showFixes = (answer: (saved: Promise<void>) => Promise<Response>) => {
  const { promise: saved, resolve: finish } = Promise.withResolvers<void>();
  serveApi((request) => (request.method === "POST" ? answer(saved) : Response.json([fix])));
  render(
    <GameContext value={{ ...game, engine: "XP" }}>
      <XpFixesCard />
    </GameContext>,
  );
  return () => finish();
};

test("a fix's switch turns at once, before its save ends", async () => {
  const finish = showFixes(async (saved) => {
    await saved;
    return Response.json([{ ...fix, on: false }]);
  });
  const toggle = page.getByRole("switch", { name: /slow-door\.rb/ });
  await toggle.click();
  await expect.element(toggle).not.toBeChecked();
  finish();
  await expect.element(toggle).not.toBeChecked();
});

test("a fix's switch turns back with the reason when its save fails", async () => {
  const finish = showFixes(async (saved) => {
    await saved;
    return Response.json(
      { _tag: "GameBusy", message: "This game is busy. Wait for the current operation." },
      { status: 400 },
    );
  });
  const toggle = page.getByRole("switch", { name: /slow-door\.rb/ });
  await toggle.click();
  await expect.element(toggle).not.toBeChecked();
  finish();
  await expect.element(page.getByText("This game is busy.", { exact: false })).toBeVisible();
  await expect.element(toggle).toBeChecked();
});
