import { expect, test } from "vite-plus/test";
import { timeLeft } from "./timeLeft.ts";

const minute = 60_000;

test("the time left follows the speed between the first and last sample", () => {
  // 100 entries in 2 minutes leaves 900 for 18 minutes.
  const samples = [
    { at: 0, done: 0 },
    { at: 2 * minute, done: 100 },
  ];
  expect(timeLeft(samples, 1000)).toBe("about 18 min left");
  expect(timeLeft(samples, 20_000)).toBe("about 6 h 40 min left");
  expect(timeLeft(samples, 18_100)).toBe("about 6 h left");
  expect(timeLeft(samples, 110)).toBe("less than a minute left");
});

test("there's no time left to tell before the run has gone on for a while", () => {
  expect(timeLeft([], 100)).toBeUndefined();
  expect(timeLeft([{ at: 0, done: 0 }], 100)).toBeUndefined();
  expect(
    timeLeft(
      [
        { at: 0, done: 0 },
        { at: 10_000, done: 5 },
      ],
      100,
    ),
  ).toBeUndefined();
  expect(
    timeLeft(
      [
        { at: 0, done: 5 },
        { at: 10 * minute, done: 5 },
      ],
      100,
    ),
  ).toBeUndefined();
});
