import type { Game, SavedGame } from "@rpgtl/contracts";

const versionInName =
  /(?:^|[^a-z0-9])((?:v|ver|version)[ ._]?(\d+(?:[._-]\d+)*[a-z]?)|(?<!\d[._-])(\d{1,2}(?:\.\d+)+[a-z]?|\d{1,2}(?:[_-]\d{1,3}){2,}[a-z]?))(?![a-z0-9])/i;

/**
 * A game's name without its version, and the version when the name has one, written as `v` and its
 * number: `Ver 1.05` and `1.05` are both `v1.05`, and `0-1-1` is `v0.1.1`. A bare number needs a
 * short first part, and three parts when dashes or underscores split them, so a date such as
 * `2022-08-06` or `2022.08.06` isn't a version.
 */
export function splitVersion(name: string): { readonly name: string; readonly version?: string } {
  const found = versionInName.exec(name);
  const written = found?.[1];
  const number = found?.[2] ?? found?.[3];
  if (!found || written === undefined || number === undefined) return { name };
  const start = found.index + found[0].length - written.length;
  const rest = [
    name.slice(0, start).replace(/[\s_\-([（【]+$/u, ""),
    name.slice(start + written.length).replace(/^[\s_\-)\]）】]+/u, ""),
  ]
    .filter(Boolean)
    .join(" ");
  return { name: rest || name, version: `v${number.toLowerCase().replaceAll(/[_-]/g, ".")}` };
}

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
