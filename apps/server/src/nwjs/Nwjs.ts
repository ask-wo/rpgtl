import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makePinnedProgram,
  type PinnedProgram,
  type ProgramRelease,
} from "../downloads/pinnedProgram.ts";

const windowsRelease: ProgramRelease = {
  version: "v0.117.0",
  url: "https://dl.nwjs.io/v0.117.0/nwjs-v0.117.0-win-x64.zip",
  size: 215_951_728,
  sha256: "0d8356b4ac1550a72a58ec86a5aa44581ce08919617f8d593a3282a3cfa7e397",
  folder: "nwjs-v0.117.0-win-x64",
  program: "nw.exe",
};

const linuxRelease: ProgramRelease = {
  version: "v0.117.0",
  url: "https://dl.nwjs.io/v0.117.0/nwjs-v0.117.0-linux-x64.tar.gz",
  size: 195_658_527,
  sha256: "2881ed1f3a9031d58d8fa0f0714d0bdac7b45d52bdec095cd72aa4f31e08debf",
  folder: "nwjs-v0.117.0-linux-x64",
  program: "nw",
};

/** The NW.js build RPGTL runs games in; tests serve a small one of their own. */
export const NwjsRelease = Context.Reference<ProgramRelease>("@rpgtl/server/nwjs/NwjsRelease", {
  defaultValue: () => (process.platform === "win32" ? windowsRelease : linuxRelease),
});

/**
 * The pinned NW.js in `nwjs/` of RPGTL's cache folder (`userFolder("cache")`), downloaded once
 * when the user asks.
 */
export class Nwjs extends Context.Service<Nwjs, PinnedProgram>()("@rpgtl/server/nwjs/Nwjs") {}

const make = Effect.gen(function* () {
  const release = yield* NwjsRelease;
  return Nwjs.of(yield* makePinnedProgram("NW.js", "nwjs", release, true));
});

export const layer = Layer.effect(Nwjs, make);
