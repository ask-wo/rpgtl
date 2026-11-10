import * as Context from "effect/Context";

/** Whether RPGTL runs on Windows; tests set it. */
export const OnWindows = Context.Reference<boolean>("@rpgtl/server/OnWindows", {
  defaultValue: () => process.platform === "win32",
});
