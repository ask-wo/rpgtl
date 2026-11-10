import * as Schema from "effect/Schema";
import { ImageRunStatus } from "./imageText.ts";
import { NwjsLaunch, NwjsStatus } from "./nwjs.ts";
import { RunStatus } from "./translation.ts";
import { ImportProgress } from "./translationFile.ts";

/**
 * Everything a game's page follows, in one stream so that a page holds one of the browser's few
 * connections to RPGTL. Each part is null until the game has one since RPGTL started.
 */
export const GameActivity = Schema.Struct({
  nwjs: NwjsStatus,
  /** The game's last start in NW.js. */
  launch: Schema.NullOr(NwjsLaunch),
  /** The game's current or last translation run. */
  translation: Schema.NullOr(RunStatus),
  /** The game's current or last image reading. */
  images: Schema.NullOr(ImageRunStatus),
  /** The import of a translation file going now. */
  importing: Schema.NullOr(ImportProgress),
});
export type GameActivity = typeof GameActivity.Type;
