import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { OnWindows } from "../OnWindows.ts";
import { userFolder } from "./userFolders.ts";

const folders = Effect.fn("folders")(function* (
  environment: Record<string, string>,
  windows: boolean,
) {
  const all = Effect.all([userFolder("config"), userFolder("state"), userFolder("cache")]);
  return yield* all.pipe(
    Effect.provideService(OnWindows, windows),
    Effect.provide(
      Layer.merge(
        ConfigProvider.layer(ConfigProvider.fromUnknown(environment)),
        NodeServices.layer,
      ),
    ),
  );
});

it.effect("the folders follow the XDG variables, else Windows' app data folders, else HOME", () =>
  Effect.gen(function* () {
    const appData = { APPDATA: "/Roaming", LOCALAPPDATA: "/Local", HOME: "/home/u" };
    assert.deepStrictEqual(yield* folders(appData, true), [
      "/Roaming/rpgtl",
      "/Local/rpgtl/state",
      "/Local/rpgtl/cache",
    ]);
    assert.deepStrictEqual(yield* folders(appData, false), [
      "/home/u/.config/rpgtl",
      "/home/u/.local/state/rpgtl",
      "/home/u/.cache/rpgtl",
    ]);
    const xdg = { XDG_CONFIG_HOME: "/c", XDG_STATE_HOME: "/s", XDG_CACHE_HOME: "/k" };
    assert.deepStrictEqual(yield* folders({ ...appData, ...xdg }, true), [
      "/c/rpgtl",
      "/s/rpgtl",
      "/k/rpgtl",
    ]);
  }),
);
