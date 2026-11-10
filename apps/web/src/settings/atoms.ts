import { Rpgtl } from "../app/Rpgtl.ts";

export const settingsKey = "settings";

export const settings = Rpgtl.query("settings", "get", { reactivityKeys: [settingsKey] });
export const saveSettings = Rpgtl.mutation("settings", "save");
