import { Api, GameNotInspected } from "@rpgtl/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as RunKinds from "../runs/RunKinds.ts";
import * as Activity from "./Activity.ts";

export const layer = HttpApiBuilder.group(
  Api,
  "activity",
  Effect.fnUntraced(function* (handlers) {
    const activity = yield* Activity.Activity;
    const runKinds = yield* RunKinds.RunKinds;
    return handlers.handleAll({
      changes: Effect.fn("activity.changes")(function* ({ query }) {
        return yield* activity
          .changes(query.id)
          .pipe(
            Effect.catchTags({ GameNotInspectedError: () => Effect.fail(new GameNotInspected()) }),
          );
      }),
      runs: () => Effect.succeed(runKinds.changes),
    });
  }),
);
