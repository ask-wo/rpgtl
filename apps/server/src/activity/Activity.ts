import type { GameActivity } from "@rpgtl/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Catalogs from "../games/Catalogs.ts";
import * as Games from "../games/Games.ts";
import * as ImageReading from "../imageText/ImageReading.ts";
import * as Launches from "../nwjs/Launches.ts";
import * as Mkxpz from "../mkxpz/Mkxpz.ts";
import * as Nwjs from "../nwjs/Nwjs.ts";
import * as Runs from "../translation/Runs.ts";

/** What a game's page follows, put together from the services that run things for the game. */
export class Activity extends Context.Service<
  Activity,
  {
    /** The game's activity now and after each change to any part, until the stream is closed. */
    readonly changes: (
      id: string,
    ) => Effect.Effect<Stream.Stream<GameActivity>, Games.GameNotInspectedError>;
  }
>()("@rpgtl/server/activity/Activity") {}

const make = Effect.gen(function* () {
  const nwjs = yield* Nwjs.Nwjs;
  const mkxpz = yield* Mkxpz.Mkxpz;
  const games = yield* Games.Games;
  const launches = yield* Launches.Launches;
  const runs = yield* Runs.Runs;
  const imageReading = yield* ImageReading.ImageReading;
  const catalogs = yield* Catalogs.Catalogs;

  const changes = Effect.fn("Activity.changes")(function* (id: string) {
    const program = (yield* games.get(id)).engine === "XP" ? mkxpz : nwjs;
    const [launch, translation, images, importing] = yield* Effect.all([
      launches.changes(id),
      runs.changes(id),
      imageReading.changes(id),
      catalogs.importChanges(id),
    ]);
    return Stream.zipLatestAll(program.changes, launch, translation, images, importing).pipe(
      Stream.map(
        ([programNow, launchNow, translationNow, imagesNow, importingNow]): GameActivity => ({
          program: programNow,
          launch: Option.getOrNull(launchNow),
          translation: Option.getOrNull(translationNow),
          images: Option.getOrNull(imagesNow),
          importing: Option.getOrNull(importingNow),
        }),
      ),
    );
  });

  return Activity.of({ changes });
});

export const layer = Layer.effect(Activity, make);
