import type { Engine } from "@rpgtl/contracts";

/** The script each engine's boot code loads first. */
export const coreScripts: Record<Engine, string> = { MV: "rpg_core.js", MZ: "rmmz_core.js" };

/**
 * The engines the boot code of `index.html` and `js/main.js` may start, most likely first. Some
 * games ship both engines' core files, so the one the boot code loads wins.
 */
export function bootEngines(html: string, main: string): ReadonlyArray<Engine> {
  const boot = html.replace(/<!--[\s\S]*?-->/g, "") + main;
  if (/src\s*=\s*["'][^"']*rpg_core\.js|Utils\.RPGMAKER_NAME\s*=\s*["']MV/i.test(boot))
    return ["MV"];
  if (/rmmz_core\.js/.test(boot)) return ["MZ"];
  return ["MZ", "MV"];
}

/** The extension of the game's image files. */
export const imageExtension = (engine: "MV" | "MZ", encrypted: boolean) =>
  encrypted ? (engine === "MV" ? ".rpgmvp" : ".png_") : ".png";
