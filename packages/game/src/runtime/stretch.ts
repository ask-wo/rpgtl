import { rm } from "./engine.ts";

// MV and MZ fit the game to its window only in NW.js and on phones, so in a browser tab and in full
// screen it stayed at its own size. F3 still switches it off.
export function hookStretch() {
  if (rm.Graphics?._defaultStretchMode) rm.Graphics._defaultStretchMode = () => true;
}
