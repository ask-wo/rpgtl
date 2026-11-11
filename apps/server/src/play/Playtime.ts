import { gameFiles, Playtime as PlaytimeFile } from "@rpgtl/contracts";
import { addPlaytime } from "@rpgtl/domain";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Games from "../games/Games.ts";
import * as StateFolder from "../state/StateFolder.ts";

/**
 * How long each game was played, in the browser or in NW.js. NW.js's hook adds to the same file
 * itself, as the game may outlive RPGTL.
 */
export class Playtime extends Context.Service<
  Playtime,
  {
    /** None until the game is first played. */
    readonly get: (
      id: string,
    ) => Effect.Effect<
      Option.Option<PlaytimeFile>,
      Games.GameNotInspectedError | StateFolder.StateFileError
    >;
    readonly add: (
      id: string,
      seconds: number,
    ) => Effect.Effect<void, Games.GameNotInspectedError | StateFolder.StateFileError>;
  }
>()("@rpgtl/server/play/Playtime") {}

const make = Effect.gen(function* () {
  const games = yield* Games.Games;
  const state = yield* StateFolder.StateFolder;
  const writing = yield* Semaphore.make(1);

  const get = Effect.fn("Playtime.get")(function* (id: string) {
    yield* games.get(id);
    return yield* state.read(gameFiles(id).playtime, PlaytimeFile);
  });

  const add = Effect.fn("Playtime.add")(function* (id: string, seconds: number) {
    yield* writing.withPermits(1)(
      Effect.gen(function* () {
        const saved = yield* get(id);
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* state.write(
          gameFiles(id).playtime,
          PlaytimeFile,
          addPlaytime(Option.getOrUndefined(saved), seconds, now),
        );
      }),
    );
  });

  return Playtime.of({ get, add });
});

export const layer = Layer.effect(Playtime, make);
