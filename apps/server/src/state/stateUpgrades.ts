import { gameFiles } from "@rpgtl/contracts";
import * as Effect from "effect/Effect";
import { entryLocations } from "./entryLocations.ts";
import type { Upgrades } from "./upgrade.ts";

const ofGames =
  (pick: (files: ReturnType<typeof gameFiles>) => ReadonlyArray<string>): Upgrades["kept"] =>
  (folder) =>
    Effect.map(folder.list("games"), (ids) => ids.flatMap((id) => pick(gameFiles(id))));

/**
 * The state folder's steps. Old catalog backups, run logs and samples aren't worth a step, so
 * they are set aside.
 */
export const stateUpgrades: Upgrades = {
  steps: [entryLocations],
  kept: (folder) =>
    Effect.map(ofGames((files) => [files.catalog, files.imageResults])(folder), (files) => [
      "games.json",
      ...files,
    ]),
  setAside: ofGames((files) => [files.backups, files.logs, files.samples]),
};
