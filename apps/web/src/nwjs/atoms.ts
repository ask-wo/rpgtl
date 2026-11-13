import * as Stream from "effect/Stream";
import { following } from "../app/following.ts";
import { Rpgtl } from "../app/Rpgtl.ts";

/** NW.js's download status, which the server sends on every change. */
export const nwjsStatus = Rpgtl.runtime.atom(
  following(Stream.unwrap(Rpgtl.use((client) => client.nwjs.status()))),
);

export const download = Rpgtl.mutation("nwjs", "download");
export const downloadProgram = Rpgtl.mutation("nwjs", "downloadProgram");
export const launch = Rpgtl.mutation("nwjs", "launch");
export const stop = Rpgtl.mutation("nwjs", "stop");
