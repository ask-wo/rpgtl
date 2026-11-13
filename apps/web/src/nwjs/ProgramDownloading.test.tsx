import { page } from "vite-plus/test/browser";
import { expect, test } from "vite-plus/test";
import { render } from "../testUtils/fakeApi.tsx";
import { ProgramDownloading } from "./ProgramDownloading.tsx";

/** Where the bar starts below the top of a frame `width` pixels wide. */
const barTop = async (width: number, received: number) => {
  const frame = document.body.appendChild(document.createElement("div"));
  frame.style.width = `${width}px`;
  render(
    <ProgramDownloading name="NW.js" version="v0.117.0" received={received} size={120e6} />,
    frame,
  );
  await expect
    .element(page.getByText(`${received / 1e6} of 120 MB`, { exact: false }))
    .toBeVisible();
  const bar = frame.querySelector('[role="progressbar"]');
  if (!bar) throw new Error("No progress bar");
  const top = bar.getBoundingClientRect().top - frame.getBoundingClientRect().top;
  frame.remove();
  return top;
};

test("the bar stays in place at any width while the count grows by a digit", async () => {
  for (let width = 150; width <= 400; width += 10)
    expect(await barTop(width, 100e6), `at ${width}px`).toBe(await barTop(width, 9e6));
});
