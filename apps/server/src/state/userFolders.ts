import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { OnWindows } from "../OnWindows.ts";

const kinds = {
  config: { xdg: "XDG_CONFIG_HOME", home: [".config"], windows: ["APPDATA"] },
  state: { xdg: "XDG_STATE_HOME", home: [".local", "state"], windows: ["LOCALAPPDATA", "state"] },
  cache: { xdg: "XDG_CACHE_HOME", home: [".cache"], windows: ["LOCALAPPDATA", "cache"] },
} as const;

/**
 * RPGTL's folder of one kind outside the state folder: `rpgtl` in the XDG folder when its variable
 * is set, else `%APPDATA%\rpgtl` for settings and `%LOCALAPPDATA%\rpgtl\<kind>` for the others on
 * Windows, else `rpgtl` in the XDG default under `HOME`.
 */
export const userFolder = Effect.fn("userFolder")(function* (kind: keyof typeof kinds) {
  const path = yield* Path.Path;
  const { xdg, home, windows } = kinds[kind];
  const set = yield* Config.String(xdg).pipe(Config.withDefault(""));
  if (set !== "") return path.join(set, "rpgtl");
  if (yield* OnWindows) {
    const [variable, ...inner] = windows;
    return path.join(yield* Config.String(variable), "rpgtl", ...inner);
  }
  return path.join(yield* Config.String("HOME"), ...home, "rpgtl");
});

/** Where RPGTL keeps state that isn't a game's, such as the agents' logins and sessions. */
export const userStateFolder = userFolder("state");
