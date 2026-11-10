import type { ImageReaderSetupStatus } from "@rpgtl/contracts";
import { page } from "vite-plus/test/browser";
import { expect, test } from "vite-plus/test";
import { events, render, serveApi } from "../testUtils/fakeApi.tsx";
import { ImageReaderCard } from "./ImageReaderCard.tsx";

const notSetUp: ImageReaderSetupStatus = {
  device: "gpu",
  download: 2.7e9,
  folder: "/home/player/.cache/rpgtl/image-reader",
  ready: false,
  onDisk: false,
  korean: { ready: false, download: 14e6 },
  phase: { _tag: "Idle" },
  attempt: 0,
};

test("the reader is set up from Settings, shows each step, and can be removed again", async () => {
  const stream = events();
  const requests = serveApi((request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/image-reader") return stream.response();
    if (pathname === "/api/image-reader/setup")
      return Response.json({ ...notSetUp, phase: { _tag: "SettingUp", step: "uv", parts: [] } });
    if (pathname === "/api/image-reader/remove") return Response.json(notSetUp);
    return new Response(null, { status: 404 });
  });
  render(<ImageReaderCard />);
  stream.send({ ...notSetUp, phase: { _tag: "Idle", error: "Installing the packages failed." } });

  await expect
    .element(page.getByText("downloads about 2.7 GB once", { exact: false }))
    .toBeVisible();
  await expect
    .element(page.getByText("Kept in /home/player/.cache/rpgtl/image-reader.", { exact: false }))
    .toBeVisible();
  await expect
    .element(page.getByText("Setting up failed: Installing the packages failed."))
    .toBeVisible();
  await page.getByRole("button", { name: "Set up the image reader" }).click();
  expect(requests).toContain("POST /api/image-reader/setup");

  stream.send({
    ...notSetUp,
    phase: {
      _tag: "SettingUp",
      step: "models",
      parts: ["textDetection", "textRecognition", "lamaDownload", "lamaCheck", "lamaExport"],
      part: "lamaDownload",
      downloading: { done: 98e6, total: 196e6 },
    },
  });
  await expect
    .element(
      page.getByText(
        "Converting the reader's models, 3 of 5: downloading LaMa, which erases text · 98 of 196 MB",
        { exact: false },
      ),
    )
    .toBeVisible();
  // Two parts of five done and half of the third.
  await expect
    .element(page.getByRole("progressbar", { name: "Image reader setup" }))
    .toHaveAttribute("aria-valuenow", "50");
  stream.send({ ...notSetUp, ready: true });
  await expect
    .element(page.getByText("The image reader is set up and runs on the NVIDIA graphics card."))
    .toBeVisible();
  await page.getByRole("button", { name: "Remove the image reader" }).click();
  expect(requests).toContain("POST /api/image-reader/remove");
  stream.send({ ...notSetUp, ready: true, onDisk: true, phase: { _tag: "Removing" } });
  await expect.element(page.getByText("Deleting the image reader's files…")).toBeVisible();
  await expect.element(page.getByRole("button")).not.toBeInTheDocument();
});

test("what a failed setup left can be deleted, or set up again", async () => {
  const stream = events();
  const requests = serveApi((request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/image-reader") return stream.response();
    if (pathname === "/api/image-reader/remove") return Response.json(notSetUp);
    return new Response(null, { status: 404 });
  });
  render(<ImageReaderCard />);
  stream.send({ ...notSetUp, onDisk: true, phase: { _tag: "Idle", error: "Converting failed." } });
  await expect.element(page.getByRole("button", { name: "Set up again" })).toBeVisible();
  await page.getByRole("button", { name: "Delete what setting up left" }).click();
  expect(requests).toContain("POST /api/image-reader/remove");
});

test("the Korean model is added from Settings once the reader is set up, and removed alone", async () => {
  const stream = events();
  const setups: Array<unknown> = [];
  const ready = {
    ...notSetUp,
    ready: true,
    onDisk: true,
    korean: { ready: false, download: 355e6 },
  };
  const requests = serveApi(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/image-reader") return stream.response();
    if (pathname === "/api/image-reader/setup") {
      setups.push(await request.json());
      return Response.json({
        ...ready,
        phase: { _tag: "SettingUp", step: "packages", parts: ["koreanRecognition"] },
      });
    }
    if (pathname === "/api/image-reader/korean/remove") return Response.json(ready);
    return new Response(null, { status: 404 });
  });
  render(<ImageReaderCard />);
  stream.send(ready);

  await expect
    .element(page.getByText("Adding it downloads about 355 MB.", { exact: false }))
    .toBeVisible();
  await page.getByRole("button", { name: "Add the Korean model" }).click();
  await expect.poll(() => setups).toEqual([{ korean: true }]);
  stream.send({ ...ready, korean: { ready: true, download: 355e6 } });
  await expect.element(page.getByText("It has the model for Korean text.")).toBeVisible();
  await page.getByRole("button", { name: "Remove the Korean model" }).click();
  expect(requests).toContain("POST /api/image-reader/korean/remove");
  expect(requests).not.toContain("POST /api/image-reader/remove");
});
