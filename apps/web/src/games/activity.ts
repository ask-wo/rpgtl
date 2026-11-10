import { type GameActivity, runEnded, runHolds } from "@rpgtl/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Stream from "effect/Stream";
import { following } from "../app/following.ts";
import { Rpgtl } from "../app/Rpgtl.ts";
import { catalogKey, imageResultsKey } from "../translation/atoms.ts";

/** Changes whenever image reading has saved more read images. */
const read = ({ images }: GameActivity) => [images?.phase._tag, images?.entries].join(" ");

/**
 * What to read again once `now` follows `previous`. The catalog follows its own changes; the games
 * list's English titles are read again once a run ends.
 */
const savedSince = (id: string, previous: GameActivity, now: GameActivity) =>
  Effect.all([
    read(previous) !== read(now) ? Reactivity.invalidate(imageResultsKey(id)) : Effect.void,
    runGoing(previous) && !runGoing(now) ? Reactivity.invalidate(catalogKey(id)) : Effect.void,
  ]);

/**
 * What the game's page follows: NW.js, the game's last start, its translation run, its image
 * reading and its import, which the server sends on every change.
 */
export const activity = Atom.family((id: string) =>
  Rpgtl.runtime.atom(
    following(
      Stream.unwrap(Rpgtl.use((client) => client.activity.changes({ query: { id } }))),
    ).pipe(
      Stream.zipWithPrevious,
      Stream.tap(([previous, now]) =>
        Option.isSome(previous) ? savedSince(id, previous.value, now) : Effect.void,
      ),
      Stream.map(([, now]) => now),
    ),
  ),
);

/** Every game's translation runs and image readings that go or wait, which the sidebar marks. */
export const queuedRuns = Rpgtl.runtime.atom(
  following(Stream.unwrap(Rpgtl.use((client) => client.activity.runs()))),
);

/** Whether a translation run or image reading holds the game, until it has let the game go. */
export const runGoing = (now: GameActivity | undefined) =>
  (!!now?.translation && runHolds(now.translation.phase)) ||
  (!!now?.images && runHolds(now.images.phase));

/** Whether a translation run or image reading of the game goes or waits for its turn. */
export const runPending = (now: GameActivity | undefined) =>
  (!!now?.translation && !runEnded(now.translation.phase)) ||
  (!!now?.images && !runEnded(now.images.phase));

/** Whether a run or an import holds the game, so its translations can't be changed meanwhile. */
export const gameHeld = (now: GameActivity | undefined) => runGoing(now) || !!now?.importing;
