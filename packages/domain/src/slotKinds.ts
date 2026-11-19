import type { Engine } from "@rpgtl/contracts";
import type { Placed } from "./location.ts";

const fighter = "a fighter's name";
const ally = "an ally's name";
const enemy = "an enemy's name";
const party = "the party's name";
const stat = "a stat's name, such as HP";
const number = "a number";

/** What fills each `%n` of an MV or MZ battle message, by the message's key in System. */
const battleRoles: Readonly<Record<string, ReadonlyArray<string>>> = {
  actionFailure: ["the target's name"],
  actorDamage: [ally, number],
  actorDrain: [ally, stat, number],
  actorGain: [ally, stat, number],
  actorLoss: [ally, stat, number],
  actorNoDamage: [ally],
  actorNoHit: [ally],
  actorRecovery: [ally, stat, number],
  buffAdd: [fighter, "a stat's name, such as Attack"],
  buffRemove: [fighter, "a stat's name, such as Attack"],
  counterAttack: [fighter],
  debuffAdd: [fighter, "a stat's name, such as Attack"],
  defeat: [party],
  emerge: [enemy],
  enemyDamage: [enemy, number],
  enemyDrain: [enemy, stat, number],
  enemyGain: [enemy, stat, number],
  enemyLoss: [enemy, stat, number],
  enemyNoDamage: [enemy],
  enemyNoHit: [enemy],
  enemyRecovery: [enemy, stat, number],
  escapeStart: [party],
  evasion: [fighter],
  expNext: ["the word for experience points"],
  expTotal: ["the word for experience points"],
  levelUp: [ally, "the word for level", number],
  magicEvasion: [fighter],
  magicReflection: [fighter],
  obtainExp: [number, "the word for experience points"],
  obtainGold: [number],
  obtainItem: ["an item's name"],
  obtainSkill: ["a skill's name"],
  partyName: ["the leader's name"],
  preemptive: [party],
  substitute: ["the protector's name", "the name of the one protected"],
  surprise: [party],
  useItem: ["the user's name", "an item's name"],
  victory: [party],
};

function battleRole(index: number, { location }: Placed, engine: Engine) {
  if (location?._tag === "SystemText" && location.keys[1] === "messages")
    return battleRoles[location.keys[2] ?? ""]?.[index];
  if (location?._tag !== "RecordField" || !/^message\d$/.test(location.field)) return undefined;
  // MV draws a state's message after the battler's name without filling in its `%1`.
  if (location.table === "states") return engine === "MZ" ? [fighter][index] : undefined;
  if (location.table !== "skills") return undefined;
  if (engine === "MZ") return ["the user's name", "the skill's name"][index];
  // MV fills a skill's messages with its name only, and draws the user's name before the first.
  return location.field === "message1"
    ? ["the skill's name; the game draws the user's name right before this message"][index]
    : ["the skill's name"][index];
}

/**
 * What the game puts where a control code stands, for the codes the engine itself defines, or
 * undefined when that isn't known.
 */
export function slotKind(code: string, entry: Placed, engine: Engine): string | undefined {
  const percent = /^%(\d)$/.exec(code);
  if (percent) return battleRole(Number(percent[1]) - 1, entry, engine);
  const name = /^\\([A-Za-z]+)(?:\[\d+\])?$/.exec(code)?.[1]?.toUpperCase();
  switch (name) {
    case "N":
      return "a character's name";
    case "P":
      return "a party member's name";
    case "V":
      return number;
    case "G":
      return engine === "XP" ? "opens the gold window, no words" : "the currency's name";
    case "I":
      return engine === "XP" ? undefined : "an icon, no words";
    case "C":
      return "a text color, no words";
    default:
      return undefined;
  }
}
