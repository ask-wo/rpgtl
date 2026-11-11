import { expect, test } from "vite-plus/test";
import { playedTime } from "./playedTime.ts";

const ticks = (clock: ReturnType<typeof playedTime>, from: number, to: number, focused = true) => {
  for (let now = from + 1000; now <= to; now += 1000) clock.tick(now, focused);
};

test("played time counts focused seconds and carries parts of a second over", () => {
  const clock = playedTime(0);
  ticks(clock, 0, 3000);
  clock.tick(3500, true);
  expect(clock.take()).toBe(3);
  clock.tick(4000, true);
  expect(clock.take()).toBe(1);
  expect(clock.take()).toBe(0);
});

test("played time leaves out time without focus", () => {
  const clock = playedTime(0);
  ticks(clock, 0, 10_000, false);
  expect(clock.take()).toBe(0);
});

test("played time stops 5 minutes after the last input and starts again with the next", () => {
  const clock = playedTime(0);
  ticks(clock, 0, 10 * 60_000);
  expect(clock.take()).toBe(5 * 60);
  clock.input(10 * 60_000);
  ticks(clock, 10 * 60_000, 10 * 60_000 + 20_000);
  expect(clock.take()).toBe(20);
});

test("played time leaves out a long gap between ticks, such as the computer sleeping", () => {
  const clock = playedTime(0);
  clock.tick(1000, true);
  clock.input(60_000);
  clock.tick(60_000, true);
  expect(clock.take()).toBe(3);
});
