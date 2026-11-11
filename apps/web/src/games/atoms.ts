import { Rpgtl } from "../app/Rpgtl.ts";

/** Refreshed by every change to the list of games. */
export const gamesKey = "games";

/** Also read again when any game's catalog changes, which can change its title's English. */
export const games = Rpgtl.query("games", "list", { reactivityKeys: [gamesKey, "catalog"] });
export const inspect = Rpgtl.mutation("games", "inspect");
export const move = Rpgtl.mutation("games", "move");
export const forget = Rpgtl.mutation("games", "forget");
/** The folders inside `path` on this computer, or in the home folder without one. */
export const folders = (path: string) =>
  Rpgtl.query("games", "folders", { query: path ? { path } : {} });
export const playtime = (id: string) => Rpgtl.query("games", "playtime", { query: { id } });
