export type MissingKind = "image" | "audio";

// Shown in the NW.js log or the browser console, and briefly on screen.
// Both engines make a new sound object each time they play a sound effect, so a missing sound is
// reported once by its URL.
const reported = new Set<string>();
let listener: ((url: string, kind: MissingKind) => void) | undefined;
export function onMissingFile(next: (url: string, kind: MissingKind) => void) {
  listener = next;
}
export function reportMissing(url: string, kind: MissingKind) {
  if (reported.has(url)) return;
  reported.add(url);
  console.warn(
    `RPGTL: ${url} could not be loaded, ${kind === "image" ? "shown blank" : "left silent"}.`,
  );
  listener?.(url, kind);
}
