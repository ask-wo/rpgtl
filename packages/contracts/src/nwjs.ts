import * as Schema from "effect/Schema";

/** Whether the pinned NW.js is downloaded, and how far a download got. */
export const NwjsStatus = Schema.Struct({
  version: Schema.String,
  /** Bytes of the download. */
  size: Schema.Int,
  /** The folder NW.js is kept in, on this computer. */
  folder: Schema.String,
  phase: Schema.Union([
    Schema.TaggedStruct("Ready", {}),
    /** `received`: bytes of the download received so far. */
    Schema.TaggedStruct("Downloading", { received: Schema.Int }),
    /** Not downloaded; `error` says why the last download failed, if it did. */
    Schema.TaggedStruct("Missing", { error: Schema.optionalKey(Schema.String) }),
  ]),
  /**
   * How many downloads started since RPGTL started. A status sent during or after one has its
   * number, so the page can tell a status from before a download it asked for.
   */
  attempt: Schema.Int,
});
export type NwjsStatus = typeof NwjsStatus.Type;

/** A game started in NW.js since RPGTL started, and how it ended. */
export const NwjsLaunch = Schema.Struct({
  phase: Schema.Union([
    Schema.TaggedStruct("Running", {}),
    Schema.TaggedStruct("Exited", { exitCode: Schema.Int }),
    /** Ended by Stop, or by a signal, which leaves no exit code. */
    Schema.TaggedStruct("Stopped", {}),
  ]),
  pid: Schema.Int,
  /** The file NW.js writes its output to. */
  log: Schema.String,
  /** The command line that starts the game the same way from a terminal. */
  command: Schema.String,
});
export type NwjsLaunch = typeof NwjsLaunch.Type;
