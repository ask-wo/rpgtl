import type { Settings } from "@rpgtl/contracts";

/** The script that tells the game runtime which display settings are on. */
export const displayFlags = ({ sharpPixels, sharpText }: Settings) =>
  `window.rpgtlSharpPixels = ${sharpPixels}; window.rpgtlSharpText = ${sharpText};`;
