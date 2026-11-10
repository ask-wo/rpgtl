import type { ServedSystem } from "@rpgtl/contracts";
import { statNames as stats } from "../statNames.ts";

type Kind =
  | "switch"
  | "variable"
  | "actor"
  | "class"
  | "skill"
  | "item"
  | "weapon"
  | "armor"
  | "enemy"
  | "troop"
  | "state"
  | "animation"
  | "tileset"
  | "commonEvent"
  | "map"
  | "equipType";
export interface Names {
  name(kind: Kind, id: number): string | undefined;
  text?(kind: "actor" | "partyMember", id: number): string | undefined;
  currencyUnit?: string | undefined;
  current?(kind: "switch" | "variable", id: number): string;
  scriptValue?(kind: "switch" | "variable", id: number): string;
  value?(kind: "switch" | "variable", id: number): unknown;
}
export interface Command {
  code: number;
  indent: number;
  parameters: unknown[];
}
export interface Line {
  code: number;
  raw: { code: number; parameters: unknown[] }[];
  label: string;
  detail: string;
  commonEvent?: number;
  children: Line[];
}
type Data = ({ name: string } | null)[];
interface CommonEventData {
  name: string;
  list?: Command[];
}
export interface GameNames {
  $dataSystem?: {
    switches?: string[];
    variables?: string[];
    equipTypes?: string[];
    currencyUnit?: string;
    rpgtlNames?: ServedSystem["rpgtlNames"];
  };
  $dataActors?: Data;
  $dataClasses?: Data;
  $dataSkills?: Data;
  $dataItems?: Data;
  $dataWeapons?: Data;
  $dataArmors?: Data;
  $dataEnemies?: Data;
  $dataTroops?: Data;
  $dataStates?: Data;
  $dataAnimations?: Data;
  $dataTilesets?: Data;
  $dataCommonEvents?: (CommonEventData | null)[];
  $dataMapInfos?: Data;
  $gameSwitches?: { value(id: number): unknown };
  $gameVariables?: { value(id: number): unknown };
  $gameActors?: { actor(id: number): unknown };
  $gameParty?: { members(): unknown[] };
}
/** A switch or variable name, translated when RPGTL put its translation beside the data. */
export function systemName(
  globals: Pick<GameNames, "$dataSystem">,
  kind: "switch" | "variable",
  id: number,
) {
  const group = kind === "switch" ? "switches" : "variables";
  return globals.$dataSystem?.rpgtlNames?.[group]?.[id] || globals.$dataSystem?.[group]?.[id];
}

type GameActor = { name?: string | (() => string) };
const nameOf = (actor: GameActor | undefined) =>
  typeof actor?.name === "function" ? actor.name() : actor?.name;

export function namesFromGame(globals: GameNames): Names {
  const tables: Partial<Record<Kind, Data | undefined>> = {
    actor: globals.$dataActors,
    class: globals.$dataClasses,
    skill: globals.$dataSkills,
    item: globals.$dataItems,
    weapon: globals.$dataWeapons,
    armor: globals.$dataArmors,
    enemy: globals.$dataEnemies,
    troop: globals.$dataTroops,
    state: globals.$dataStates,
    animation: globals.$dataAnimations,
    tileset: globals.$dataTilesets,
    commonEvent: globals.$dataCommonEvents,
    map: globals.$dataMapInfos,
  };
  return {
    name(kind, id) {
      if (kind === "switch" || kind === "variable") return systemName(globals, kind, id);
      if (kind === "equipType") return globals.$dataSystem?.equipTypes?.[id];
      return tables[kind]?.[id]?.name;
    },
    text(kind, id) {
      if (kind === "actor")
        return (
          nameOf(globals.$gameActors?.actor(id) as GameActor | undefined) ??
          globals.$dataActors?.[id]?.name
        );
      return nameOf(globals.$gameParty?.members()[id - 1] as GameActor | undefined);
    },
    currencyUnit: globals.$dataSystem?.currencyUnit,
    value: (kind, id) => gameValue(globals, kind, id),
    scriptValue: (kind, id) => scriptNote(globals, kind, id),
  };
}
export const gameValue = (globals: GameNames, kind: "switch" | "variable", id: number) =>
  kind === "switch" ? globals.$gameSwitches?.value(id) : globals.$gameVariables?.value(id);
/** The note after a script's switch or variable call: its name and value, a string quoted. */
export function scriptNote(globals: GameNames, kind: "switch" | "variable", id: number) {
  const name =
    systemName(globals, kind, id) ?? `${kind === "switch" ? "Switch" : "Variable"} ${id}`;
  const value = gameValue(globals, kind, id);
  const display =
    value === undefined
      ? "undefined"
      : kind === "switch"
        ? value
          ? "ON"
          : "OFF"
        : (JSON.stringify(value) ?? String(value));
  return `‹${name} = ${display}›`;
}
/** The note after a command's switch or variable: its value now. */
export const currentNote = (kind: "switch" | "variable", value: unknown) =>
  value === undefined ? "" : ` (now ${kind === "switch" ? (value ? "ON" : "OFF") : text(value)})`;
export function canExpand(commonEventId: number, ancestors: number[]): boolean {
  return !ancestors.includes(commonEventId);
}
const labels: Record<number, string> = {
  101: "Show Text",
  102: "Show Choices",
  103: "Input Number",
  104: "Select Item",
  105: "Show Scrolling Text",
  108: "Comment",
  109: "Skip",
  111: "Conditional Branch",
  112: "Loop",
  113: "Break Loop",
  115: "Exit Event Processing",
  117: "Call Common Event",
  118: "Label",
  119: "Jump to Label",
  121: "Control Switches",
  122: "Control Variables",
  123: "Control Self Switch",
  124: "Control Timer",
  125: "Change Gold",
  126: "Change Items",
  127: "Change Weapons",
  128: "Change Armors",
  129: "Change Party Member",
  132: "Change Battle BGM",
  133: "Change Victory ME",
  134: "Change Save Access",
  135: "Change Menu Access",
  136: "Change Encounter",
  137: "Change Formation Access",
  138: "Change Window Color",
  139: "Change Defeat ME",
  140: "Change Vehicle BGM",
  201: "Transfer Player",
  202: "Set Vehicle Location",
  203: "Set Event Location",
  204: "Scroll Map",
  205: "Set Movement Route",
  206: "Get on/off Vehicle",
  211: "Change Transparency",
  212: "Show Animation",
  213: "Show Balloon Icon",
  214: "Erase Event",
  216: "Change Player Followers",
  217: "Gather Followers",
  221: "Fadeout Screen",
  222: "Fadein Screen",
  223: "Tint Screen",
  224: "Flash Screen",
  225: "Shake Screen",
  230: "Wait",
  231: "Show Picture",
  232: "Move Picture",
  233: "Rotate Picture",
  234: "Tint Picture",
  235: "Erase Picture",
  236: "Set Weather Effect",
  241: "Play BGM",
  242: "Fadeout BGM",
  243: "Save BGM",
  244: "Resume BGM",
  245: "Play BGS",
  246: "Fadeout BGS",
  249: "Play ME",
  250: "Play SE",
  251: "Stop SE",
  261: "Play Movie",
  281: "Change Map Name Display",
  282: "Change Tileset",
  283: "Change Battle Background",
  284: "Change Parallax",
  285: "Get Location Info",
  301: "Battle Processing",
  302: "Shop Processing",
  303: "Name Input Processing",
  311: "Change HP",
  312: "Change MP",
  313: "Change State",
  314: "Recover All",
  315: "Change EXP",
  316: "Change Level",
  317: "Change Parameter",
  318: "Change Skill",
  319: "Change Equipment",
  320: "Change Name",
  321: "Change Class",
  322: "Change Actor Images",
  323: "Change Vehicle Image",
  324: "Change Nickname",
  325: "Change Profile",
  326: "Change TP",
  331: "Change Enemy HP",
  332: "Change Enemy MP",
  333: "Change Enemy State",
  334: "Enemy Recover All",
  335: "Enemy Appear",
  336: "Enemy Transform",
  337: "Show Battle Animation",
  339: "Force Action",
  340: "Abort Battle",
  342: "Change Enemy TP",
  351: "Open Menu Screen",
  352: "Open Save Screen",
  353: "Game Over",
  354: "Return to Title Screen",
  355: "Script",
  356: "Plugin Command",
  357: "Plugin Command",
  402: "When",
  403: "When Cancel",
  411: "Else",
  601: "If Win",
  602: "If Escape",
  603: "If Lose",
};
const directions: Record<number, string> = {
  0: "retain",
  2: "down",
  4: "left",
  6: "right",
  8: "up",
};
const direction = (n: unknown) => directions[Number(n)] ?? String(n);
const vehicle = (n: unknown) => ["Boat", "Ship", "Airship"][Number(n)] ?? `Vehicle ${n}`;
const character = (n: unknown) =>
  Number(n) === -1 ? "Player" : Number(n) === 0 ? "This event" : `Event ${n}`;
const enemySlot = (n: unknown) => (Number(n) < 0 ? "All enemies" : `Enemy slot ${Number(n) + 1}`);
const text = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");
const on = (value: unknown) => (value === 0 ? "ON" : "OFF");

const escapedSlash = "\uE000";
function displayText(value: string, names: Names): string {
  let result = value.replace(/\\\\/g, escapedSlash);
  for (let pass = 0; pass < 100; pass++) {
    const previous = result;
    result = result.replace(/\\V\[(\d+)\]/gi, (code, id) => {
      const currentValue = names.value?.("variable", Number(id));
      return currentValue === undefined ? code : String(currentValue);
    });
    if (result === previous) break;
  }
  result = result.replace(/\\N\[(\d+)\]/gi, (code, id) => {
    const actorName = names.text?.("actor", Number(id));
    return actorName === undefined ? code : actorName;
  });
  result = result.replace(/\\P\[(\d+)\]/gi, (code, id) => {
    const partyMemberName = names.text?.("partyMember", Number(id));
    return partyMemberName === undefined ? code : partyMemberName;
  });
  result = result.replace(/\\G/gi, (code) => names.currencyUnit ?? code);
  result = result.replace(/\\(?:C|I|PX|PY|FS)\[\d+\]/gi, "");
  result = result.replace(/\\[{}$.|!><^]/g, "");
  return result.replaceAll(escapedSlash, "\\");
}

function messageText(value: string, names: Names): { speaker?: string | undefined; text: string } {
  const speakerTag = /^\\n<([^>]*)>/.exec(value);
  const content = speakerTag ? value.slice(speakerTag[0].length) : value;
  return {
    speaker: speakerTag ? displayText(speakerTag[1]!, names) : undefined,
    text: displayText(content, names),
  };
}

function scriptText(source: string, names: Names): string {
  const notes: { at: number; value: string }[] = [];
  const call = /\$game(Variables|Switches)\.(value|setValue)\(\s*(\d+)\s*/y;
  // The last index of the comment or string that starts at `index`, if one does.
  const skipped = (index: number) => {
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      return newline < 0 ? source.length : newline - 1;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      return end < 0 ? source.length : end + 1;
    }
    const quote = source[index];
    if (quote !== "'" && quote !== '"' && quote !== "`") return undefined;
    while (++index < source.length) {
      if (source[index] === "\\") index++;
      else if (source[index] === quote) break;
    }
    return index;
  };
  const closingParen = (open: number): number => {
    let depth = 1;
    for (let index = open + 1; index < source.length; index++) {
      const end = skipped(index);
      if (end !== undefined) index = end;
      else if (source[index] === "(") depth++;
      else if (source[index] === ")" && --depth === 0) return index + 1;
    }
    return -1;
  };
  for (let index = 0; index < source.length; index++) {
    const skip = skipped(index);
    if (skip !== undefined) {
      index = skip;
      continue;
    }
    call.lastIndex = index;
    const match = call.exec(source);
    if (!match || (index > 0 && /[\w$.]/.test(source[index - 1]!))) continue;
    const end = closingParen(source.indexOf("(", index));
    if (end < 0) continue;
    const kind = match[1] === "Variables" ? "variable" : "switch";
    const note = names.scriptValue?.(kind, Number(match[3]));
    if (note) notes.push({ at: end, value: ` ${note}` });
  }
  for (const note of notes.toReversed())
    source = source.slice(0, note.at) + note.value + source.slice(note.at);
  return source;
}

const facing = (d: unknown) => (Number(d) > 0 ? `, facing ${direction(d)}` : "");
const audio = (value: unknown) => {
  const a = value as { name?: string; volume?: number; pitch?: number; pan?: number } | undefined;
  return a ? `${a.name ?? "None"}, volume ${a.volume}, pitch ${a.pitch}, pan ${a.pan}` : "";
};

function reader(names: Names) {
  const ref = (kind: Kind, id: unknown) => {
    const name = names.name(kind, Number(id));
    return `${id}${name ? ` "${name}"` : ""}`;
  };
  const variable = (id: unknown) => `Variable ${ref("variable", id)}`;
  const current = (kind: "switch" | "variable", id: unknown) =>
    names.current
      ? names.current(kind, Number(id))
      : currentNote(kind, names.value?.(kind, Number(id)));
  const actor = (mode: unknown, id: unknown) =>
    mode === 1 ? variable(id) : id === 0 ? "Entire party" : `Actor ${ref("actor", id)}`;
  const amount = (operation: unknown, mode: unknown, value: unknown) =>
    `${operation === 0 ? "+" : "−"}${mode === 0 ? text(value) : variable(value)}`;
  const point = (mode: unknown, x: unknown, y: unknown) =>
    mode === 0
      ? `(${x}, ${y})`
      : `(x: variable ${ref("variable", x)}, y: variable ${ref("variable", y)})`;
  const target = (mode: unknown, map: unknown, x: unknown, y: unknown) =>
    `${mode === 0 ? `Map ${ref("map", map)}` : `Map: variable ${ref("variable", map)}`} ${point(mode, x, y)}`;
  function gameData(type: unknown, id: unknown, field: unknown): string {
    const n = Number(field);
    switch (type) {
      case 0:
      case 1:
      case 2:
        return `Count of ${["Item", "Weapon", "Armor"][type]} ${ref((["item", "weapon", "armor"] as Kind[])[type]!, id)}`;
      case 3:
        return `Actor ${ref("actor", id)} ${["Level", "EXP", "HP", "MP", ...stats, "TP"][n]}`;
      case 4:
        return `${enemySlot(id)} ${["HP", "MP", ...stats, "TP"][n]}`;
      case 5:
        return `${character(id)} ${["Map X", "Map Y", "Direction", "Screen X", "Screen Y"][n]}`;
      case 6:
        return `Party member ${Number(id) + 1} actor ID`;
      case 7:
        return (
          [
            "Map ID",
            "Party members",
            "Gold",
            "Steps",
            "Play time",
            "Timer",
            "Save count",
            "Battle count",
            "Win count",
            "Escape count",
          ][Number(id)] ?? ""
        );
      case 8:
        return `Last ${["used skill ID", "used item ID", "acting actor ID", "acting enemy index", "target actor ID", "target enemy index"][Number(id)]}`;
      default:
        return `Game data ${type}, ${id}, ${field}`;
    }
  }
  function condition(p: unknown[]): string {
    switch (p[0]) {
      case 0:
        return `Switch ${ref("switch", p[1])} = ${on(p[2])}${current("switch", p[1])}`;
      case 1:
        return `${variable(p[1])} ${["=", "≥", "≤", ">", "<", "≠"][Number(p[4])]} ${p[2] === 0 ? text(p[3]) : variable(p[3])}${current("variable", p[1])}`;
      case 2:
        return `Self switch ${p[1]} = ${on(p[2])}`;
      case 3:
        return `Timer ${p[2] === 0 ? "≥" : "≤"} ${p[1]} seconds`;
      case 4: {
        const a = `Actor ${ref("actor", p[1])}`;
        if (p[2] === 0) return `${a} in party`;
        if (p[2] === 1) return `${a} name = ${text(p[3])}`;
        const kind = (["class", "skill", "weapon", "armor", "state"] as Kind[])[Number(p[2]) - 2]!;
        return `${a} has ${kind} ${ref(kind, p[3])}`;
      }
      case 5:
        return `${enemySlot(p[1])} ${p[2] === 0 ? "is alive" : `has state ${ref("state", p[3])}`}`;
      case 6:
        return `${character(p[1])} facing ${direction(p[2])}`;
      case 7:
        return `Gold ${["≥", "≤", "<"][Number(p[2])]} ${p[1]}`;
      case 8:
      case 9:
      case 10: {
        const kind = (["item", "weapon", "armor"] as Kind[])[Number(p[0]) - 8]!;
        return `Party has ${kind} ${ref(kind, p[1])}${p[2] ? " (including equipped)" : ""}`;
      }
      case 11:
        return `Button ${p[1]} ${["pressed", "triggered", "repeated"][Number(p[2] ?? 0)]}`;
      case 12:
        return `Script: ${scriptText(text(p[1]), names)}`;
      case 13:
        return `Player in ${vehicle(p[1])}`;
      default:
        return `Condition ${text(p)}`;
    }
  }
  function detail(code: number, p: unknown[]): string {
    switch (code) {
      case 102:
        return (
          (p[0] as string[] | undefined)?.map((choice) => displayText(choice, names)).join(" / ") ??
          ""
        );
      case 103:
        return `${variable(p[0])}, ${p[1]} digits`;
      case 104:
        return `${variable(p[0])}, ${["", "Regular items", "Key items", "Hidden items A", "Hidden items B"][Number(p[1] || 2)]}`;
      case 111:
        return condition(p);
      case 117:
        return ref("commonEvent", p[0]);
      case 118:
      case 119:
      case 261:
      case 356:
        return text(p[0]);
      case 121:
      case 122: {
        const kind = code === 121 ? "switch" : "variable";
        const single = p[0] === p[1];
        const subject = `${code === 121 ? "Switch" : "Variable"}${single ? ` ${ref(kind, p[0])}` : `s ${p[0]}–${p[1]}`}`;
        if (code === 121) return `${subject} = ${on(p[2])}${single ? current(kind, p[0]) : ""}`;
        const operand =
          p[3] === 0
            ? text(p[4])
            : p[3] === 1
              ? variable(p[4])
              : p[3] === 2
                ? `Random ${p[4]}–${p[5]}`
                : p[3] === 3
                  ? gameData(p[4], p[5], p[6])
                  : `Script: ${scriptText(text(p[4]), names)}`;
        return `${subject} ${["=", "+=", "-=", "*=", "/=", "%="][Number(p[2])]} ${operand}${single ? current(kind, p[0]) : ""}`;
      }
      case 123:
        return `Self switch ${p[0]} = ${on(p[1])}`;
      case 124:
        return p[0] === 0 ? `Start ${p[1]} seconds` : "Stop";
      case 125:
        return amount(p[0], p[1], p[2]);
      case 126:
      case 127:
      case 128:
        return `${ref((["item", "weapon", "armor"] as Kind[])[code - 126]!, p[0])} ${amount(p[1], p[2], p[3])}${p[4] ? ", include equipped" : ""}`;
      case 129:
        return `${p[1] === 0 ? "Add" : "Remove"} actor ${ref("actor", p[0])}${p[2] ? ", initialize" : ""}`;
      case 132:
      case 133:
      case 139:
      case 241:
      case 245:
      case 249:
      case 250:
        return audio(p[0]);
      case 134:
      case 135:
      case 136:
      case 137:
        return p[0] === 0 ? "Disable" : "Enable";
      case 138:
        return `Tone ${text(p[0])}`;
      case 140:
        return `${vehicle(p[0])}: ${audio(p[1])}`;
      case 201:
        return (
          target(p[0], p[1], p[2], p[3]) +
          facing(p[4]) +
          (p[5] === 1 ? ", white fade" : p[5] === 2 ? ", no fade" : "")
        );
      case 202:
        return `${vehicle(p[0])}: ${target(p[1], p[2], p[3], p[4])}`;
      case 203:
        return `${character(p[0])}: ${p[1] === 2 ? `Exchange with ${character(p[2])}` : point(p[1], p[2], p[3])}${facing(p[4])}`;
      case 204:
        return `${direction(p[0])}, ${p[1]} tiles, speed ${p[2]}${p[3] ? ", wait" : ""}`;
      case 205: {
        const route = p[1] as { repeat?: boolean; skippable?: boolean; wait?: boolean } | undefined;
        return `${character(p[0])}${route?.repeat ? ", repeat" : ""}${route?.skippable ? ", skip if blocked" : ""}${route?.wait ? ", wait" : ""}`;
      }
      case 211:
      case 281:
        return p[0] === 0 ? "ON" : "OFF";
      case 212:
        return `${character(p[0])}: animation ${ref("animation", p[1])}${p[2] ? ", wait" : ""}`;
      case 213:
        return `${character(p[0])}: ${["", "Exclamation", "Question", "Music", "Heart", "Anger", "Sweat", "Cobweb", "Silence", "Light bulb", "Sleep"][Number(p[1])] ?? `Balloon ${p[1]}`}${p[2] ? ", wait" : ""}`;
      case 216:
        return p[0] === 0 ? "Show" : "Hide";
      case 223:
      case 224:
        return `${code === 223 ? "Tone" : "Color"} ${text(p[0])}, ${p[1]} frames${p[2] ? ", wait" : ""}`;
      case 225:
        return `Power ${p[0]}, speed ${p[1]}, ${p[2]} frames${p[3] ? ", wait" : ""}`;
      case 230:
        return `${p[0]} frames`;
      case 231:
      case 232:
        return `Picture ${p[0]}${code === 231 ? ` "${p[1]}"` : ""}, ${p[2] === 0 ? "upper left" : "center"} ${point(p[3], p[4], p[5])}, scale ${p[6]}% × ${p[7]}%, opacity ${p[8]}, blend ${["normal", "add", "multiply", "screen"][Number(p[9])]}${code === 232 ? `, ${p[10]} frames${p[11] ? ", wait" : ""}, easing ${["linear", "ease in", "ease out", "ease in/out"][Number(p[12] ?? 0)]}` : ""}`;
      case 233:
        return `Picture ${p[0]}, speed ${p[1]}`;
      case 234:
        return `Picture ${p[0]}, tone ${text(p[1])}, ${p[2]} frames${p[3] ? ", wait" : ""}`;
      case 235:
        return `Picture ${p[0]}`;
      case 236:
        return `${p[0]}, power ${p[1]}, ${p[2]} frames${p[3] ? ", wait" : ""}`;
      case 242:
      case 246:
        return `${p[0]} seconds`;
      case 282:
        return ref("tileset", p[0]);
      case 283:
        return `${p[0]} / ${p[1]}`;
      case 284:
        return `${p[0]}, horizontal loop ${!!p[1]} speed ${p[3]}, vertical loop ${!!p[2]} speed ${p[4]}`;
      case 285:
        return `${variable(p[0])} = ${["Terrain tag", "Event ID", "Tile ID layer 1", "Tile ID layer 2", "Tile ID layer 3", "Tile ID layer 4", "Region ID"][Number(p[1])]} at ${p[2] === 2 ? character(p[3]) : point(p[2], p[3], p[4])}`;
      case 301:
        return `${p[0] === 0 ? `Troop ${ref("troop", p[1])}` : p[0] === 1 ? variable(p[1]) : "Random encounter"}${p[2] ? ", allow escape" : ""}${p[3] ? ", allow defeat" : ""}`;
      case 302:
      case 605:
        return `${["Item", "Weapon", "Armor"][Number(p[0])]} ${ref((["item", "weapon", "armor"] as Kind[])[Number(p[0])] ?? "item", p[1])}, price ${p[2] === 0 ? "standard" : p[3]}${p[4] ? ", purchase only" : ""}`;
      case 303:
        return `Actor ${ref("actor", p[0])}, ${p[1]} characters`;
      case 311:
      case 312:
      case 315:
      case 316:
      case 326:
        return `${actor(p[0], p[1])}: ${amount(p[2], p[3], p[4])}${p[5] ? (code === 311 ? ", allow knockout" : ", show level up") : ""}`;
      case 313:
      case 318:
        return `${actor(p[0], p[1])}: ${p[2] === 0 ? "Add" : "Remove"} ${code === 313 ? "state" : "skill"} ${ref(code === 313 ? "state" : "skill", p[3])}`;
      case 314:
        return actor(p[0], p[1]);
      case 317:
        return `${actor(p[0], p[1])}: ${stats[Number(p[2])]} ${amount(p[3], p[4], p[5])}`;
      case 319:
        return `Actor ${ref("actor", p[0])}, slot ${ref("equipType", p[1])}: ${ref(p[1] === 1 ? "weapon" : "armor", p[2])}`;
      case 320:
      case 324:
      case 325:
        return `Actor ${ref("actor", p[0])}: ${text(p[1])}`;
      case 321:
        return `Actor ${ref("actor", p[0])}: class ${ref("class", p[1])}${p[2] ? ", keep EXP" : ""}`;
      case 322:
        return `Actor ${ref("actor", p[0])}: character ${p[1]} #${p[2]}, face ${p[3]} #${p[4]}, battler ${p[5]}`;
      case 323:
        return `${vehicle(p[0])}: ${p[1]} #${p[2]}`;
      case 331:
      case 332:
      case 342:
        return `${enemySlot(p[0])}: ${amount(p[1], p[2], p[3])}${p[4] ? ", allow knockout" : ""}`;
      case 333:
        return `${enemySlot(p[0])}: ${p[1] === 0 ? "Add" : "Remove"} state ${ref("state", p[2])}`;
      case 334:
      case 335:
        return enemySlot(p[0]);
      case 336:
        return `${enemySlot(p[0])}: enemy ${ref("enemy", p[1])}`;
      case 337:
        return `${enemySlot(p[2] ? -1 : p[0])}: animation ${ref("animation", p[1])}`;
      case 339:
        return `${p[0] === 0 ? enemySlot(p[1]) : actor(0, p[1])}: skill ${ref("skill", p[2])}, target ${p[3] === -2 ? "last target" : p[3] === -1 ? "random" : `slot ${Number(p[3]) + 1}`}`;
      default:
        return labels[code] ? "" : JSON.stringify(p);
    }
  }
  return { ref, detail };
}

const moveLabels = [
  "End route",
  "Move down",
  "Move left",
  "Move right",
  "Move up",
  "Move lower left",
  "Move lower right",
  "Move upper left",
  "Move upper right",
  "Move at random",
  "Move toward player",
  "Move away from player",
  "Move forward",
  "Move backward",
  "Jump",
  "Wait",
  "Turn down",
  "Turn left",
  "Turn right",
  "Turn up",
  "Turn 90° right",
  "Turn 90° left",
  "Turn 180°",
  "Turn 90° at random",
  "Turn at random",
  "Turn toward player",
  "Turn away from player",
  "Switch ON",
  "Switch OFF",
  "Change speed",
  "Change frequency",
  "Walking animation ON",
  "Walking animation OFF",
  "Stepping animation ON",
  "Stepping animation OFF",
  "Direction fix ON",
  "Direction fix OFF",
  "Through ON",
  "Through OFF",
  "Transparent ON",
  "Transparent OFF",
  "Change image",
  "Change opacity",
  "Change blend mode",
  "Play SE",
  "Script",
];
function moveLine(command: Command, names: Names): Line {
  const move = command.parameters[0] as { code: number; parameters?: unknown[] };
  const p = move.parameters ?? [];
  const r = reader(names);
  let label = moveLabels[move.code] ?? `Move code ${move.code}`;
  let detail = "";
  switch (move.code) {
    case 14:
      detail = `(${p[0]}, ${p[1]})`;
      break;
    case 15:
      detail = `${p[0]} frames`;
      break;
    case 27:
    case 28:
      label = `Switch ${r.ref("switch", p[0])} ${move.code === 27 ? "ON" : "OFF"}`;
      break;
    case 29:
    case 30:
    case 42:
    case 45:
      detail = text(p[0]);
      break;
    case 41:
      detail = `${p[0]} #${p[1]}`;
      break;
    case 43:
      detail = ["normal", "add", "multiply", "screen"][Number(p[0])] ?? text(p[0]);
      break;
    case 44:
      detail = audio(p[0]);
      break;
    default:
      if (!moveLabels[move.code]) detail = JSON.stringify(p);
  }
  return {
    code: command.code,
    raw: [{ code: command.code, parameters: command.parameters }],
    label,
    detail,
    children: [],
  };
}
const continuation: Record<number, number> = {
  101: 401,
  105: 405,
  108: 408,
  355: 655,
  357: 657,
  205: 505,
  302: 605,
};
const closing = new Set([0, 404, 412, 413, 604]);
export function decodeCommands(list: Command[], names: Names): Line[] {
  const roots: Line[] = [];
  const frames: { indent: number; line: Line }[] = [];
  const blocks = new Map<number, Line>();
  const r = reader(names);
  for (let i = 0; i < list.length; i++) {
    const command = list[i]!;
    const { code, indent, parameters: p } = command;
    while (frames.length && frames.at(-1)!.indent >= indent) frames.pop();
    if (closing.has(code)) {
      for (const depth of blocks.keys()) if (depth >= indent) blocks.delete(depth);
      continue;
    }
    const branch = code === 402 || code === 403 || code === 601 || code === 602 || code === 603;
    const owner = blocks.get(indent);
    const branchOwner =
      branch && owner && (code < 600 ? owner.code === 102 : owner.code === 301) ? owner : undefined;
    for (const depth of blocks.keys())
      if (depth > indent || (depth === indent && !branchOwner)) blocks.delete(depth);
    const line: Line = {
      code,
      raw: [{ code, parameters: p }],
      label:
        code === 402 ? `When ${displayText(text(p[1]), names)}` : (labels[code] ?? `Code ${code}`),
      detail: r.detail(code, p),
      children: [],
    };
    if (code === 117) line.commonEvent = Number(p[0]);
    const extra: Command[] = [];
    while (continuation[code] !== undefined && list[i + 1]?.code === continuation[code]) {
      const next = list[++i]!;
      extra.push(next);
      line.raw.push({ code: next.code, parameters: next.parameters });
    }
    if (code === 101 || code === 105 || code === 108 || code === 355) {
      const content = [
        ...(code === 108 || code === 355 ? [text(p[0])] : []),
        ...extra.map((c) => text(c.parameters[0])),
      ].join("\n");
      const message = code === 101 ? messageText(content, names) : { text: content };
      if (code === 101) {
        const ownSpeaker = displayText(text(p[4]), names);
        const faceSpeaker = p[0] ? `${p[0]} #${p[1]}` : "";
        const speaker = ownSpeaker
          ? [ownSpeaker, message.speaker].filter(Boolean).join(": ")
          : message.speaker || faceSpeaker;
        line.detail = speaker ? `${speaker}: ${message.text}` : message.text;
      } else {
        line.detail =
          code === 105
            ? displayText(message.text, names)
            : code === 355
              ? scriptText(message.text, names)
              : message.text;
      }
    }
    if (code === 357) {
      const args = p[3] as Record<string, unknown> | undefined;
      line.detail = [
        `${text(p[0])}: ${text(p[1])}`,
        ...Object.entries(args ?? {}).map(([key, value]) => `${key} = ${text(value)}`),
      ].join("\n");
    }
    if (code === 205) line.children = extra.map((c) => moveLine(c, names));
    if (code === 302)
      line.detail = [line.detail, ...extra.map((c) => r.detail(605, c.parameters))].join("\n");
    const parent = branchOwner ?? frames.at(-1)?.line;
    (parent?.children ?? roots).push(line);
    frames.push({ indent, line });
    if (code === 102 || code === 301) blocks.set(indent, line);
  }
  return roots;
}
