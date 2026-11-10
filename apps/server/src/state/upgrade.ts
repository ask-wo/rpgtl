import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { StateFileError, StateFolder } from "./StateFolder.ts";

type Folder = StateFolder["Service"];

const versionFile = "version.json";
const FolderVersion = Schema.Struct({
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

/** A folder whose files a newer RPGTL saved, in a format this one doesn't know. */
export class NewerFolderError extends Schema.TaggedError<NewerFolderError>()("NewerFolderError", {
  folder: Schema.String,
  version: Schema.Int,
  latest: Schema.Int,
}) {
  override get message() {
    return `A newer RPGTL saved the files in ${this.folder} (format ${this.version}; this RPGTL reads formats up to ${this.latest}). Update RPGTL to use them.`;
  }
}

/** How the files of a folder RPGTL keeps change from one format to the next. */
export interface Upgrades {
  /**
   * The step from format n to n + 1 at index n - 1. A step reads and writes the files as plain
   * JSON through schemas of its own, never the current contracts, which go on changing after it.
   * A step stopped halfway runs again on what it left, so it must accept files it already changed.
   */
  readonly steps: ReadonlyArray<(folder: Folder) => Effect.Effect<void, StateFileError>>;
  /** The files the steps change, copied to `old/v<n>/` before the step from format n. */
  readonly kept: (folder: Folder) => Effect.Effect<ReadonlyArray<string>, StateFileError>;
  /** The files no step changes, moved to `old/v<n>/` before the step from format n. */
  readonly setAside: (folder: Folder) => Effect.Effect<ReadonlyArray<string>, StateFileError>;
}

/**
 * Brings the folder's files to the latest format, which is one more than the number of steps. A
 * folder without `version.json` is taken to be new, so it gets the latest format.
 */
export const upgrade = Effect.fn("upgrade")(function* (folder: Folder, upgrades: Upgrades) {
  const latest = upgrades.steps.length + 1;
  const saved = yield* folder.read(versionFile, FolderVersion);
  const from = Option.match(saved, { onNone: () => latest, onSome: (file) => file.version });
  if (from > latest)
    return yield* new NewerFolderError({ folder: folder.root, version: from, latest });
  if (Option.isNone(saved)) yield* folder.write(versionFile, FolderVersion, { version: from });
  for (const [index, step] of upgrades.steps.entries()) {
    const version = index + 1;
    if (version < from) continue;
    const old = `old/v${version}`;
    // The copy is whole once renamed, so a start after a crash keeps the files from before it.
    if (!(yield* folder.list("old")).includes(`v${version}`)) {
      const part = `${old}.part`;
      yield* folder.remove(part);
      for (const file of yield* upgrades.kept(folder)) yield* folder.copy(file, `${part}/${file}`);
      yield* folder.move(part, old);
    }
    for (const file of yield* upgrades.setAside(folder)) yield* folder.move(file, `${old}/${file}`);
    yield* step(folder);
    yield* folder.write(versionFile, FolderVersion, { version: version + 1 });
  }
});
