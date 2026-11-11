import { expect, test } from "vite-plus/test";
import { playtimeText } from "./playtimeText.ts";

const lastPlayed = "2026-03-04T12:00:00.000Z";
const date = new Date(lastPlayed).toLocaleDateString(undefined, { dateStyle: "medium" });

test("playtime reads in hours and minutes", () => {
  expect(playtimeText({ seconds: 42, lastPlayed })).toBe(
    `Played less than a minute, last on ${date}`,
  );
  expect(playtimeText({ seconds: 25 * 60 + 59, lastPlayed })).toBe(
    `Played 25 min, last on ${date}`,
  );
  expect(playtimeText({ seconds: 3 * 3600, lastPlayed })).toBe(`Played 3 h, last on ${date}`);
  expect(playtimeText({ seconds: 12 * 3600 + 30 * 60, lastPlayed })).toBe(
    `Played 12 h 30 min, last on ${date}`,
  );
});
