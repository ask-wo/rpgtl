import { Rpgtl } from "../app/Rpgtl.ts";

/** Refreshed by Unpack and its undo. */
export const archiveKey = (id: string) => ({ xpArchive: [id] });

export const xpArchive = (id: string) =>
  Rpgtl.query("xpPatch", "archive", { query: { id }, reactivityKeys: archiveKey(id) });

export const unpack = Rpgtl.mutation("xpPatch", "unpack");
export const pack = Rpgtl.mutation("xpPatch", "pack");

/** The zip of the game's translated data files that Export patch downloads. */
export const patchFile = Rpgtl.runtime.fn(({ id, images }: { id: string; images: boolean }) =>
  Rpgtl.use((client) =>
    client.xpPatch.patch({ query: { id, ...(!images && { images: "none" as const }) } }),
  ),
);

/** Refreshed by turning a fix on or off. */
export const fixesKey = (id: string) => ({ xpFixes: [id] });

export const xpFixes = (id: string) =>
  Rpgtl.query("xpPatch", "fixes", { query: { id }, reactivityKeys: fixesKey(id) });

export const setFix = Rpgtl.mutation("xpPatch", "setFix");
