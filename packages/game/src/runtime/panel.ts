import { type RpgMaker, rm } from "./engine.ts";
import { type MissingKind, onMissingFile } from "./missingFiles.ts";
import { atDecision, isSkipping, onSkipChange, setSkipping } from "./skip.ts";
import { statNames as stats } from "../statNames.ts";

const style = `
  * { box-sizing: border-box }
  button, input, select {
    font: inherit; background: #243248; color: #f4f7ff;
    border: 1px solid #52627b; border-radius: 6px; padding: 7px;
  }
  button { cursor: pointer }
  label { display: block; margin: 10px 0 }
  input[type=number] { width: 105px }
  select { max-width: 230px }
  section {
    width: 330px; max-height: 85vh; overflow: auto; padding: 20px;
    background: #111c2ef5; color: #f4f7ff; border: 1px solid #52627b; border-radius: 14px;
    font: 14px system-ui; box-shadow: 0 12px 50px #0008;
  }
  section[hidden] { display: none }
  h2 { margin: 0 0 10px; font-size: 18px }
  .row { display: flex; gap: 7px; margin: 10px 0; align-items: center }
  #status { color: #aac8fd; white-space: pre-wrap }
  small { color: #b4c4dc }
  .badge {
    margin-bottom: 8px; padding: 7px 12px; background: #111c2ef5; color: #f4f7ff;
    border: 1px solid #52627b; border-radius: 10px; font: 14px system-ui;
    max-width: 420px; overflow-wrap: anywhere;
  }
  .badge[hidden] { display: none }
`;

const markup = `
  <div id="skip" class="badge" role="status" hidden></div>
  <div id="missing" class="badge" role="status" hidden></div>
  <section hidden>
    <h2>RPGTL game controls</h2>
    <small>F8 opens or closes this panel. F7 opens the map view. F9 fast-forwards dialogue to the next choice. Save to keep changes: Save game opens the save screen even where the game turns saving off.</small>
    <div class="row">
      <input id="gold" type="number" min="0" value="10000" aria-label="Gold">
      <button id="setGold">Set gold</button>
    </div>
    <button id="mapView">Map view</button>
    <button id="save">Save game</button>
    <button id="heal">Heal party</button>
    <label><input id="encounters" type="checkbox"> Disable random encounters</label>
    <label><input id="through" type="checkbox"> Walk through obstacles</label>
    <label>Item type
      <select id="kind">
        <option value="Items">Items</option>
        <option value="Weapons">Weapons</option>
        <option value="Armors">Armor</option>
      </select>
    </label>
    <select id="item" aria-label="Item"></select>
    <div class="row">
      <input id="quantity" type="number" value="1" aria-label="Item quantity">
      <button id="give">Add items</button>
    </div>
    <label>Actor <select id="actor"></select></label>
    <select id="param" aria-label="Stat">
      ${stats.map((name, i) => `<option value="${i}">${name}</option>`).join("")}
    </select>
    <div class="row">
      <input id="bonus" type="number" value="10" aria-label="Stat bonus">
      <button id="stat">Add stat bonus</button>
    </div>
    <label>Variable <select id="variable"></select></label>
    <div class="row">
      <input id="value" type="number" value="0" aria-label="Variable value">
      <button id="setVariable">Set value</button>
    </div>
    <label>Switch <select id="switch"></select></label>
    <label><input id="enabled" type="checkbox"> Enabled</label>
    <button id="setSwitch">Set switch</button>
    <p id="status" role="status">Load a save or start a new game first.</p>
  </section>
`;

const party = () => {
  if (!rm.$gameParty || !rm.$gamePlayer || !rm.$gameParty.members().length)
    throw new Error("Start a new game or load a save first.");
  return rm.$gameParty;
};

/** The F8 panel, the badges F9 and missing files show, and the switch that turns encounters off. */
export function mountPanel(
  SceneManager: NonNullable<RpgMaker["SceneManager"]>,
  Game_Player: NonNullable<RpgMaker["Game_Player"]>,
) {
  let noEncounters = false;
  const executeEncounter = Game_Player.prototype.executeEncounter;
  Game_Player.prototype.executeEncounter = function () {
    return noEncounters ? false : executeEncounter.call(this);
  };

  const host = document.createElement("div");
  host.style.cssText = "position:fixed;right:18px;top:18px;";
  // MV's Graphics.initialize sets every existing element's z-index to 0, so each opening raises it again.
  const raise = () => (host.style.zIndex = "2147483647");
  raise();
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${style}</style>${markup}`;
  // Keep the game from reacting to input meant for the panel.
  for (const type of ["keydown", "keyup", "mousedown", "touchstart", "wheel"])
    host.addEventListener(type, (event) => event.stopPropagation());

  const panel = shadow.querySelector("section")!;
  // Chrome moves the focus off a hidden control only at its next frame. Until then the listeners
  // above keep a key pressed right after closing from the game.
  const hidePanel = () => {
    panel.hidden = true;
    const focused = shadow.activeElement;
    if (focused && "blur" in focused && typeof focused.blur === "function") focused.blur();
  };
  const $ = <T extends HTMLElement = HTMLInputElement>(id: string) =>
    shadow.getElementById(id) as T;
  const setStatus = (text: string) => ($("status").textContent = text);

  const skipBadge = $("skip");
  let hideSkipBadge: ReturnType<typeof setTimeout> | undefined;
  const showSkipBadge = (text: string) => {
    clearTimeout(hideSkipBadge);
    skipBadge.textContent = text;
    skipBadge.hidden = false;
    raise();
  };
  // Files that fail close together are listed in one badge.
  const missingBadge = $("missing");
  let missing: string[] = [];
  const kinds = new Set<MissingKind>();
  let hideMissingBadge: ReturnType<typeof setTimeout> | undefined;
  onMissingFile((url, kind) => {
    if (missingBadge.hidden) {
      missing = [];
      kinds.clear();
    }
    kinds.add(kind);
    let name = url;
    try {
      name = decodeURIComponent(url);
    } catch {}
    missing.push(name);
    const more = missing.length > 3 ? ` and ${missing.length - 3} more` : "";
    const many = missing.length > 1;
    const what =
      kinds.size > 1
        ? "Files missing, left out"
        : kind === "image"
          ? `${many ? "Images" : "Image"} missing, shown blank`
          : `${many ? "Sounds" : "Sound"} missing, left silent`;
    missingBadge.textContent = `${what}: ${missing.slice(0, 3).join(", ")}${more}.`;
    missingBadge.hidden = false;
    raise();
    clearTimeout(hideMissingBadge);
    hideMissingBadge = setTimeout(() => (missingBadge.hidden = true), 5000);
  });
  onSkipChange(() => {
    if (isSkipping()) showSkipBadge("Fast forward to the next choice. F9 stops.");
    else skipBadge.hidden = true;
  });

  const number = (id: string) => {
    const raw = $(id).value;
    const value = Number(raw);
    if (!raw.trim() || !Number.isSafeInteger(value) || Math.abs(value) > 999_999_999)
      throw new Error("Enter a whole number between -999999999 and 999999999.");
    return value;
  };

  const action = (id: string, fn: () => void) => {
    $(id).onclick = () => {
      try {
        fn();
        setStatus(`Done. Gold: ${party().gold()}`);
      } catch (error) {
        setStatus((error as Error).message);
      }
    };
  };

  const fillOptions = <T>(
    id: string,
    values: (T | null)[],
    label: (value: T, index: number) => string,
    original?: (value: T, index: number) => string | undefined,
  ) => {
    const select = $<HTMLSelectElement>(id);
    select.replaceChildren();
    values.forEach((value, index) => {
      if (!index || value == null) return;
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${index}: ${label(value, index) || "(unnamed)"}`;
      const source = original?.(value, index);
      if (source && source !== label(value, index)) option.title = source;
      select.append(option);
    });
  };

  const itemList = () => rm[`$data${$<HTMLSelectElement>("kind").value}` as "$dataItems"] ?? [];
  const fillItems = () => fillOptions("item", itemList(), (item) => item.name);
  $("kind").onchange = fillItems;

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.code === "F9") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat) return;
        if (isSkipping()) setSkipping(false);
        else if (!atDecision()) setSkipping(true);
        else {
          showSkipBadge("Nothing to skip: no dialogue or cutscene is running.");
          hideSkipBadge = setTimeout(() => (skipBadge.hidden = true), 2000);
        }
        return;
      }
      if (event.code !== "F8") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!panel.hidden) return hidePanel();
      panel.hidden = false;
      raise();
      $("through").checked = rm.$gamePlayer?.isThrough() ?? false;
      fillItems();
      fillOptions("actor", rm.$dataActors ?? [], (actor) => actor.name);
      fillOptions(
        "variable",
        rm.$dataSystem?.variables ?? [],
        (name, index) => rm.$dataSystem?.rpgtlNames?.variables?.[index] ?? name,
        (name) => name,
      );
      fillOptions(
        "switch",
        rm.$dataSystem?.switches ?? [],
        (name, index) => rm.$dataSystem?.rpgtlNames?.switches?.[index] ?? name,
        (name) => name,
      );
      setStatus(
        rm.$gameParty ? `Gold: ${rm.$gameParty.gold()}` : "Start a new game or load a save first.",
      );
    },
    true,
  );

  $("mapView").onclick = () => {
    hidePanel();
    document.dispatchEvent(new CustomEvent("rpgtl-map-view"));
  };

  // The save screen saves whatever state the game is in, even where the game turns saving off.
  // A message or choice in progress is not part of a save, so a load would skip it.
  $("save").onclick = () => {
    const { Scene_Save, Scene_Map } = rm;
    try {
      party();
      if (!SceneManager.push || !Scene_Save || !Scene_Map)
        throw new Error("This game has no save screen to open.");
      if (!(SceneManager._scene instanceof Scene_Map) || SceneManager.isSceneChanging?.())
        throw new Error("Return to the map first: saving works only there.");
      if (rm.$gameMessage?.isBusy?.())
        throw new Error("Wait until the message or choice closes, then save.");
    } catch (error) {
      setStatus((error as Error).message);
      return;
    }
    hidePanel();
    SceneManager.push(Scene_Save);
  };

  action("setGold", () => {
    const value = number("gold");
    if (value < 0) throw new Error("Gold cannot be negative.");
    party().gainGold(value - party().gold());
  });
  action("heal", () =>
    party()
      .members()
      .forEach((actor) => actor.recoverAll()),
  );
  action("give", () => {
    party();
    const item = itemList()[number("item")];
    if (!item) throw new Error("Select an item.");
    party().gainItem(item, number("quantity"));
  });
  action("stat", () => {
    party();
    const actor = rm.$gameActors.actor(number("actor"));
    if (!actor) throw new Error("Select an actor.");
    actor.addParam(number("param"), number("bonus"));
  });
  action("setVariable", () => {
    party();
    rm.$gameVariables.setValue(number("variable"), number("value"));
  });
  action("setSwitch", () => {
    party();
    rm.$gameSwitches.setValue(number("switch"), $("enabled").checked);
  });

  $("encounters").onchange = () => {
    noEncounters = $("encounters").checked;
  };
  $("through").onchange = () => {
    if (rm.$gamePlayer) rm.$gamePlayer.setThrough($("through").checked);
    else $("through").checked = false;
  };
}
