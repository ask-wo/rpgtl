/** The scripts RPGTL puts into a game, by the name the game loads them as. */
export const scriptFiles = ["runtime.js", "map-view.js", "nwjs-hook.js"] as const;
export type ScriptFile = (typeof scriptFiles)[number];

/** Where the NW.js hook reads the game's data and RPGTL's state for the game. */
export interface HookConfig {
  readonly catalog: string;
  readonly data: string;
  readonly erased: string;
  readonly images: string;
  readonly log: string;
  readonly root: string;
}

/** The script NW.js runs before the game's page: the hook with its settings, the runtime and the map view. */
export const hookScript = (config: HookConfig, built: Readonly<Record<ScriptFile, string>>) =>
  [
    `(() => { const rpgtl = ${JSON.stringify(config)}; ${built["nwjs-hook.js"]} })();`,
    built["runtime.js"],
    built["map-view.js"],
  ].join("\n");
