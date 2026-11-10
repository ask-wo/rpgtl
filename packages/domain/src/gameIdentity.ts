import type { Game, SavedGame } from "@rpgtl/contracts";

const versionInName =
  /(?:^|[^a-z0-9])((?:v|ver|version)[ ._]?\d+(?:\.\d+)*[a-z]?|\d+(?:\.\d+)+[a-z]?)(?![a-z0-9])/i;

/** The version in a game folder's name, such as `v0.41`, `1.2.3` or `Ver1.05`. */
export const folderVersion = (name: string) => versionInName.exec(name)?.[1];

type Identified = Pick<Game, "engine" | "title" | "identity">;

/**
 * Whether two games are versions of the same game: `sure` when their data says so, `maybe` when
 * only their titles match. Titles repeat and change between versions, so a `maybe` needs the user.
 */
export function sameGameAs(a: Identified, b: Identified): "sure" | "maybe" | undefined {
  if (a.engine !== b.engine) return undefined;
  const ids = [a.identity?.gameId, b.identity?.gameId];
  if (ids[0] !== undefined && ids[1] !== undefined) return ids[0] === ids[1] ? "sure" : undefined;
  if (a.title !== b.title) return undefined;
  const key = a.identity?.encryptionKey;
  return key !== undefined && key === b.identity?.encryptionKey ? "sure" : "maybe";
}

/**
 * The saved games in other folders that `found` seems to be another version of, the surest and
 * then the most recently added first.
 */
export const otherVersions = (
  found: Identified & Pick<Game, "webRoot">,
  saved: ReadonlyArray<SavedGame>,
) =>
  saved
    .flatMap((game) => {
      if (game.webRoot === found.webRoot) return [];
      const same = sameGameAs(found, game);
      return same ? [{ game, sure: same === "sure" }] : [];
    })
    .toReversed()
    .toSorted((a, b) => Number(b.sure) - Number(a.sure));
