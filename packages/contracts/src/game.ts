import * as Schema from "effect/Schema";
import { Engine } from "./catalog.ts";

/** A file the game's data asks for that isn't in the game, such as `img/faces/$Arlene`. */
export const MissingFile = Schema.Struct({
  path: Schema.String,
  /** The data files that ask for it. */
  files: Schema.Array(Schema.String),
});
export type MissingFile = typeof MissingFile.Type;

/** What a game's `data/System.json` carries that is taken to stay the same across its versions. */
export const GameIdentity = Schema.Struct({
  /** MZ's `advanced.gameId`. */
  gameId: Schema.optionalKey(Schema.Finite),
  encryptionKey: Schema.optionalKey(Schema.String),
});
export type GameIdentity = typeof GameIdentity.Type;

/** One build of a game. */
export const GameBuild = Schema.Struct({
  /** System.json's `versionId`, which the engine compares with a save's to tell builds apart. */
  versionId: Schema.optionalKey(Schema.Finite),
  /**
   * SHA-256 of `data/*.json` and `js/plugins.js`, which also changes when a build is patched by
   * hand without RPG Maker.
   */
  sha256: Schema.String,
  /** The version in the folder's name, such as `v0.41`, or else the date of the newest data file. */
  label: Schema.String,
});
export type GameBuild = typeof GameBuild.Type;

/** An inspected game, as `games.json` in the state folder lists it. */
export const Game = Schema.Struct({
  /** A name for the game's state folder and addresses, not what makes it the same game. */
  id: Schema.String,
  root: Schema.String,
  webRoot: Schema.String,
  engine: Engine,
  title: Schema.String,
  files: Schema.Array(Schema.String),
  encryptedAssets: Schema.Boolean,
  mediaWarnings: Schema.Array(Schema.String),
  missingImages: Schema.Array(MissingFile),
  /** Read on every inspection; a game saved without it gets it when it is opened again. */
  missingAudio: Schema.optionalKey(Schema.Array(MissingFile)),
  /** Read on every open; a game saved without it gets it on its next open. */
  identity: Schema.optionalKey(GameIdentity),
  /** Read on every open; a game saved without it gets it on its next open. */
  build: Schema.optionalKey(GameBuild),
});
export type Game = typeof Game.Type;

/**
 * A saved game in another folder that the opened folder's game seems to be another version of,
 * which opening it asks about first.
 */
export const OtherVersion = Schema.Struct({
  /** The saved game, which may have been removed from the list. */
  game: Game,
  /** The English of the saved game's title, when it has one. */
  titleTranslation: Schema.optionalKey(Schema.String),
  /** The game's data says so, as MZ's game id does; otherwise only the title matches. */
  sure: Schema.Boolean,
  /** The opened folder's version label. */
  label: Schema.String,
});
export type OtherVersion = typeof OtherVersion.Type;

/**
 * What opening a folder does with a saved game it seems to be another version of: replace that
 * game, which then keeps its id and translations in the new folder, or keep both.
 */
export const VersionChoice = Schema.Union([
  Schema.Struct({ replace: Schema.String }),
  Schema.Literal("keepBoth"),
]);
export type VersionChoice = typeof VersionChoice.Type;

/**
 * A game in `games.json`. One removed from the list stays there, marked, so opening its folder
 * again finds its translations.
 */
export const SavedGame = Schema.Struct({
  ...Game.fields,
  removed: Schema.optionalKey(Schema.Literal(true)),
});
export type SavedGame = typeof SavedGame.Type;

/** `games.json` in the state folder. */
export const Games = Schema.Array(SavedGame);

/**
 * A game as the list of games gives it: the inspected game, the English of its title and whether
 * its folder is gone.
 */
export const ListedGame = Schema.Struct({
  ...Game.fields,
  titleTranslation: Schema.optionalKey(Schema.String),
  /** No game is in its folder any more, as when the folder moved. */
  folderMissing: Schema.optionalKey(Schema.Literal(true)),
});
export type ListedGame = typeof ListedGame.Type;

/**
 * `games/<id>/playtime.json`: how long the game was played, counting only time with its window
 * focused and the player not idle.
 */
export const Playtime = Schema.Struct({
  seconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** An ISO time. */
  lastPlayed: Schema.String,
});
export type Playtime = typeof Playtime.Type;

/** Seconds of play the game runtime reports at once; it reports about every 30 seconds. */
export const PlayedSeconds = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 }));

/** A folder on the server's computer, as the page's folder browser shows it. */
export const FolderListing = Schema.Struct({
  /** The folder's absolute path. */
  path: Schema.String,
  /** The folder holding it; null at the top of a drive or of the file system. */
  parent: Schema.NullOr(Schema.String),
  /** The user's home folder. */
  home: Schema.String,
  /** The tops of the file system: `/`, or each drive on Windows. */
  roots: Schema.Array(Schema.String),
  /** The folders inside it, sorted by name; `game` when one holds an MV or MZ game's data. */
  folders: Schema.Array(
    Schema.Struct({ name: Schema.String, path: Schema.String, game: Schema.Boolean }),
  ),
});
export type FolderListing = typeof FolderListing.Type;
