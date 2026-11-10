import { Settings as SettingsSchema } from "@rpgtl/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as StateFolder from "../state/StateFolder.ts";
import { userFolder } from "../state/userFolders.ts";
import { upgrade, type Upgrades } from "../state/upgrade.ts";

const file = "settings.json";
const defaults = Schema.decodeSync(SettingsSchema)({});

const settingsUpgrades: Upgrades = {
  steps: [],
  kept: () => Effect.succeed([file]),
  setAside: () => Effect.succeed([]),
};

/** The choices the page restores on load, in `settings.json` in RPGTL's settings folder (`userFolder("config")`). */
export class Settings extends Context.Service<
  Settings,
  {
    /** The saved settings, with defaults for those never saved. */
    readonly get: Effect.Effect<SettingsSchema, StateFolder.StateFileError>;
    readonly save: (settings: SettingsSchema) => Effect.Effect<void, StateFolder.StateFileError>;
  }
>()("@rpgtl/server/settings/Settings") {}

const make = Effect.gen(function* () {
  const folder = yield* StateFolder.make(yield* userFolder("config"));
  yield* upgrade(folder, settingsUpgrades);

  const get = folder
    .read(file, SettingsSchema)
    .pipe(Effect.map(Option.getOrElse(() => defaults)), Effect.withSpan("Settings.get"));

  const save = Effect.fn("Settings.save")(function* (settings: SettingsSchema) {
    yield* folder.write(file, SettingsSchema, settings);
  });

  return Settings.of({ get, save });
});

export const layer = Layer.effect(Settings, make);
