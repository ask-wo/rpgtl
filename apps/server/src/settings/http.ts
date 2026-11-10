import { Api } from "@rpgtl/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { stateFileFailed } from "../state/http.ts";
import * as Settings from "./Settings.ts";

export const layer = HttpApiBuilder.group(
  Api,
  "settings",
  Effect.fnUntraced(function* (handlers) {
    const settings = yield* Settings.Settings;
    return handlers.handleAll({
      get: Effect.fn("settings.get")(function* () {
        return yield* settings.get.pipe(Effect.catchTags({ StateFileError: stateFileFailed }));
      }),
      save: Effect.fn("settings.save")(function* ({ payload }) {
        return yield* settings
          .save(payload)
          .pipe(Effect.catchTags({ StateFileError: stateFileFailed }));
      }),
    });
  }),
);
