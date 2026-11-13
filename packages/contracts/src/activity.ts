import * as Schema from "effect/Schema";
import { ImageRunStatus } from "./imageText.ts";
import { GameLaunch, ProgramStatus } from "./nwjs.ts";
import { RunStatus } from "./translation.ts";
import { ImportProgress } from "./translationFile.ts";

/**
 * Everything a game's page follows, in one stream so that a page holds one of the browser's few
 * connections to RPGTL. Each part is null until the game has one since RPGTL started.
 */
export const GameActivity = Schema.Struct({
  /** The program Play starts the game in: NW.js, or mkxp-z for an XP game. */
  program: ProgramStatus,
  /** The game's last start with Play. */
  launch: Schema.NullOr(GameLaunch),
  /** The game's current or last translation run. */
  translation: Schema.NullOr(RunStatus),
  /** The game's current or last image reading. */
  images: Schema.NullOr(ImageRunStatus),
  /** The import of a translation file going now. */
  importing: Schema.NullOr(ImportProgress),
});
export type GameActivity = typeof GameActivity.Type;
