const idleAfter = 5 * 60_000;
// A longer gap between ticks means the computer slept or the game stalled, which isn't play.
const longestTick = 2000;

/**
 * Counts the milliseconds played: those while the game window has focus and the player gave input
 * in the last 5 minutes.
 */
export function playedTime(start: number) {
  let lastInput = start;
  let lastTick = start;
  let played = 0;
  return {
    input(now: number) {
      lastInput = now;
    },
    tick(now: number, focused: boolean) {
      const step = Math.min(now - lastTick, longestTick);
      lastTick = now;
      if (focused && now - lastInput <= idleAfter) played += step;
    },
    /** The whole seconds played since the last call; the rest carries over. */
    take() {
      const seconds = Math.floor(played / 1000);
      played -= seconds * 1000;
      return seconds;
    },
  };
}
