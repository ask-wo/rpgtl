import * as Schema from "effect/Schema";

/** A program RPGTL runs games in: NW.js for MV and MZ, mkxp-z for XP. */
export const ProgramName = Schema.Literals(["NW.js", "mkxp-z"]);
export type ProgramName = typeof ProgramName.Type;

/** Whether a pinned program is downloaded, and how far a download got. */
export const ProgramStatus = Schema.Struct({
  name: ProgramName,
  version: Schema.String,
  /** Bytes of the download. */
  size: Schema.Int,
  /** The folder the program is kept in, on this computer. */
  folder: Schema.String,
  phase: Schema.Union([
    Schema.TaggedStruct("Ready", {}),
    /** `received`: bytes of the download received so far. */
    Schema.TaggedStruct("Downloading", { received: Schema.Int }),
    /** Not downloaded; `error` says why the last download failed, if it did. */
    Schema.TaggedStruct("Missing", { error: Schema.optionalKey(Schema.String) }),
    /** The release doesn't run on this computer's system. */
    Schema.TaggedStruct("Unsupported", {}),
  ]),
  /**
   * How many downloads started since RPGTL started. A status sent during or after one has its
   * number, so the page can tell a status from before a download it asked for.
   */
  attempt: Schema.Int,
});
export type ProgramStatus = typeof ProgramStatus.Type;

/** A game started with Play since RPGTL started, and how it ended. */
export const GameLaunch = Schema.Struct({
  phase: Schema.Union([
    Schema.TaggedStruct("Running", {}),
    Schema.TaggedStruct("Exited", { exitCode: Schema.Int }),
    /** Ended by Stop, or by a signal, which leaves no exit code. */
    Schema.TaggedStruct("Stopped", {}),
  ]),
  pid: Schema.Int,
  /** The file the program writes its output to. */
  log: Schema.String,
  /** The command line that starts the game the same way from a terminal. */
  command: Schema.String,
});
export type GameLaunch = typeof GameLaunch.Type;
