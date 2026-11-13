import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makePinnedProgram,
  type PinnedProgram,
  type ProgramRelease,
} from "../downloads/pinnedProgram.ts";

// rpgmakermlinux-cicpoffs's build: mkxp-z with the RPG Maker RTPs and Kawariki's preload scripts,
// which stand in for the Windows-only calls XP games make. mkxp-z itself publishes no releases.
const appImage: ProgramRelease = {
  version: "2.4.2-ca1af68",
  url: "https://github.com/bakustarver/rpgmakermlinux-cicpoffs/releases/download/appimagev1/mkxpz-allrtps-Kawariki-x86_64.AppImage",
  size: 305_075_392,
  sha256: "f37c101bb8e64b1f4b9eacfc2b13f4372d8b2947d31bd831c5bc967b3c7e6ce5",
  folder: "squashfs-root",
  program: "mkxp-z.x86_64",
  appImage: true,
};

/** The mkxp-z build RPGTL runs XP games in; tests serve a small one of their own. */
export const MkxpzRelease = Context.Reference<ProgramRelease>("@rpgtl/server/mkxpz/MkxpzRelease", {
  defaultValue: () => appImage,
});

/**
 * The pinned mkxp-z in `mkxpz/` of RPGTL's cache folder, downloaded once when the user asks. The
 * build runs only on 64-bit x86 Linux.
 */
export class Mkxpz extends Context.Service<Mkxpz, PinnedProgram>()("@rpgtl/server/mkxpz/Mkxpz") {}

const make = Effect.gen(function* () {
  const release = yield* MkxpzRelease;
  const supported = process.platform === "linux" && process.arch === "x64";
  return Mkxpz.of(yield* makePinnedProgram("mkxp-z", "mkxpz", release, supported));
});

export const layer = Layer.effect(Mkxpz, make);

/**
 * The `mkxp.json` that plays the game at `root` in the mkxp-z of the folder `dir`, reading data
 * files from `patches` before the game's own. The other settings are those the build's own
 * launcher uses for XP games.
 */
export const mkxpConfig = (dir: string, root: string, patches: string) => ({
  gameFolder: root,
  patches: [patches],
  preloadScript: [`${dir}/Kawariki-patches/preload.rb`],
  RTP: [`${dir}/RGSS/Standard`],
  syntaxTransform: 2,
  fontHeightReporting: 1,
});
