import { rm } from "./engine.ts";

// A save made before its text was translated still holds the original in variables set by
// scripts and in actor names, which the game shows and compares with translated text.
const translate = (result: unknown) => {
  const translations = rm.$dataSystem?.rpgtlSaveText;
  return typeof result === "string" && translations && Object.hasOwn(translations, result)
    ? translations[result]
    : result;
};

export function hookSaveText() {
  const variables = rm.Game_Variables?.prototype;
  if (variables) {
    const value = variables.value;
    variables.value = function (this: unknown, id: number) {
      return translate(value.call(this, id));
    };
  }
  const actor = rm.Game_Actor?.prototype;
  for (const method of ["name", "nickname", "profile"] as const) {
    const original = actor?.[method];
    if (!actor || typeof original !== "function") continue;
    actor[method] = function (this: unknown) {
      return translate(original.call(this));
    };
  }
}
