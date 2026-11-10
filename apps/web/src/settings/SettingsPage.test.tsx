import { Settings } from "@rpgtl/contracts";
import * as Schema from "effect/Schema";
import { page } from "vite-plus/test/browser";
import { expect, test, vi } from "vite-plus/test";
import { render, serveApi } from "../testUtils/fakeApi.tsx";
import { SettingsPage } from "./SettingsPage.tsx";

test("a second switch flipped while the first saves keeps the first, and they save in order", async () => {
  let current = Schema.decodeSync(Settings)({});
  const sent: Array<Settings> = [];
  const { promise: firstHeld, resolve: releaseFirst } = Promise.withResolvers<void>();
  serveApi(async (request) => {
    if (new URL(request.url).pathname !== "/api/settings")
      return new Response(null, { status: 404 });
    if (request.method !== "POST") return Response.json(current);
    const next: Settings = await request.json();
    sent.push(next);
    if (sent.length === 1) await firstHeld;
    current = next;
    return new Response(null, { status: 204 });
  });
  render(<SettingsPage />);

  const pixels = page.getByRole("switch", { name: "Sharp pixels" });
  const text = page.getByRole("switch", { name: "Sharp text" });
  await pixels.click();
  await expect.element(pixels).toBeChecked();
  await text.click();
  await expect.element(text).toBeChecked();
  await expect.element(pixels).toBeChecked();

  releaseFirst();
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  expect(sent.map(({ sharpPixels, sharpText }) => [sharpPixels, sharpText])).toEqual([
    [true, false],
    [true, true],
  ]);
  await vi.waitFor(() => expect(current).toMatchObject({ sharpPixels: true, sharpText: true }));
  await expect.element(pixels).toBeChecked();
  await expect.element(text).toBeChecked();
});

test("a save that fails says why and shows the saved settings again", async () => {
  const current = Schema.decodeSync(Settings)({});
  serveApi((request) => {
    if (new URL(request.url).pathname !== "/api/settings")
      return new Response(null, { status: 404 });
    if (request.method !== "POST") return Response.json(current);
    return Response.json(
      {
        _tag: "StateFileFailed",
        file: "settings.json",
        operation: "write",
        message: "Couldn't write settings.json.",
      },
      { status: 500 },
    );
  });
  render(<SettingsPage />);

  const pixels = page.getByRole("switch", { name: "Sharp pixels" });
  await pixels.click();
  await expect.element(page.getByText("Couldn't write settings.json.")).toBeVisible();
  await expect.element(pixels).not.toBeChecked();
});
