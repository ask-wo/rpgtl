import { useRef } from "react";

/** How far a run had got at a moment, in milliseconds since the epoch. */
interface Sample {
  readonly at: number;
  readonly done: number;
}

/** The speed is measured over this much of the run's latest progress. */
const window = 5 * 60_000;
/** Progress over less time than this gives too rough a speed to show. */
const shortest = 30_000;

/**
 * How long the rest of a run takes at the speed between the first and last of `samples`, such as
 * "about 25 min left"; none until they span long enough to tell.
 */
export const timeLeft = (samples: ReadonlyArray<Sample>, total: number): string | undefined => {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || last.done <= first.done || last.at - first.at < shortest) return undefined;
  const minutes = ((total - last.done) * (last.at - first.at)) / (last.done - first.done) / 60_000;
  if (minutes < 1) return "less than a minute left";
  if (minutes < 60) return `about ${Math.round(minutes)} min left`;
  const rounded = Math.round(minutes / 5) * 5;
  const hours = Math.floor(rounded / 60);
  return rounded % 60 ? `about ${hours} h ${rounded % 60} min left` : `about ${hours} h left`;
};

/**
 * `timeLeft` over the last few minutes of a run whose status the page receives as it changes.
 * While `busy` with something else, such as loading the model, and when `done` goes back, as
 * when a run moves on to its next part, the measure starts again.
 */
export const useTimeLeft = (done: number, total: number, busy: boolean): string | undefined => {
  const samples = useRef<ReadonlyArray<Sample>>([]);
  const now = Date.now();
  const last = samples.current.at(-1);
  if (busy || !last || done < last.done) samples.current = [{ at: now, done }];
  else if (done > last.done)
    samples.current = [
      ...samples.current.filter((sample) => sample.at >= now - window),
      { at: now, done },
    ];
  return timeLeft(samples.current, total);
};
