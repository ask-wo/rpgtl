import { drawMap, fit, markerAt, tileAt } from "./canvas.ts";
import type { Camera } from "./canvas.ts";
import { makeDetailPanel } from "./detail.ts";
import type { EventDetail } from "./detail.ts";
import { fillLegend } from "./legend.ts";
import { markup } from "./markup.ts";
import {
  dataEventPages,
  dataMapSnapshot,
  eventPages,
  mapSnapshot,
  teleport,
  teleportTarget,
} from "./model.ts";
import type { DataMap, MapGame, MapSnapshot } from "./model.ts";
import { makeSprites } from "./sprites.ts";
import { markerSummary, nameWithOriginal, tileDescription } from "./words.ts";

/** The map the view shows: the player's, or another one, loaded from its data file. */
type Shown =
  | { readonly _tag: "Player" }
  | { readonly _tag: "Other"; readonly mapId: number; readonly error?: string };

type Selection =
  | { readonly _tag: "Event"; readonly id: number }
  | { readonly _tag: "Tile"; readonly x: number; readonly y: number };

export function mountMapView(game: MapGame) {
  const host = document.createElement("div");
  host.id = "rpgtl-map-view";
  host.hidden = true;
  host.style.cssText = "position:fixed;inset:0;padding:16px;z-index:2147483647;";
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = markup;
  const inputEvents = [
    "click",
    "dblclick",
    "auxclick",
    "contextmenu",
    "mousedown",
    "mouseup",
    "mousemove",
    "mouseover",
    "mouseout",
    "mouseenter",
    "mouseleave",
    "pointerdown",
    "pointerup",
    "pointermove",
    "pointerrawupdate",
    "pointerover",
    "pointerout",
    "pointerenter",
    "pointerleave",
    "pointercancel",
    "gotpointercapture",
    "lostpointercapture",
    "touchstart",
    "touchmove",
    "touchend",
    "touchcancel",
    "wheel",
    "mousewheel",
  ];
  for (const type of inputEvents) {
    window.addEventListener(
      type,
      (event) => {
        if (!host.hidden && !event.composedPath().includes(host)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      { capture: true, passive: false },
    );
    host.addEventListener(type, (event) => event.stopPropagation());
  }
  const get = <T extends HTMLElement>(id: string) => shadow.getElementById(id) as T;
  const canvas = get<HTMLCanvasElement>("map");
  const ctx = canvas.getContext("2d")!;
  const filter = get<HTMLInputElement>("filter");
  const picker = get<HTMLSelectElement>("map-picker");
  const back = get<HTMLButtonElement>("back");
  const tileSelection = get<HTMLSpanElement>("tile-selection");
  const teleportTileButton = get<HTMLButtonElement>("teleport-tile");
  const mapStatus = get<HTMLParagraphElement>("map-status");
  const tooltip = get<HTMLDivElement>("tooltip");
  const events = get<HTMLDivElement>("events");
  let shown: Shown = { _tag: "Player" };
  // Which map the selection, status and camera belong to; a change resets them.
  let shownMap: { readonly map: unknown; readonly mapId: number } | undefined;
  let snapshot: MapSnapshot | undefined;
  let selection: Selection | undefined;
  let pendingTeleport:
    | { readonly mapId: number; readonly x: number; readonly y: number }
    | undefined;
  let actionStatus = "";
  let camera: Camera = { tile: 24, offsetX: 0, offsetY: 0 };
  let smallest = 1;
  let fitNext = true;
  let frame = 0;
  let refreshGrid = true;
  let requestedMapId = game.$gameMap?.mapId() ?? 0;
  if (game.DataManager) {
    const loadMapData = game.DataManager.loadMapData;
    game.DataManager.loadMapData = function (mapId) {
      requestedMapId = mapId;
      return loadMapData.call(this, mapId);
    };
  }
  const sprites = makeSprites(game, (name) => panel.sheetLoaded(name));
  const panel = makeDetailPanel(get("detail"), game, sprites, teleportTo);
  let rowsKey = "";
  let drag: { x: number; y: number; startX: number; startY: number; moved: boolean } | undefined;
  let hover: { x: number; y: number } | undefined;
  let pickerKey = "";
  const dataMaps = new Map<number, DataMap>();
  const loadingMaps = new Map<number, Promise<DataMap>>();

  function resetMapState() {
    selection = undefined;
    actionStatus = "";
    sprites.clearFrames();
    panel.reset();
    rowsKey = "";
    drag = undefined;
    hover = undefined;
    tooltip.hidden = true;
    fitNext = true;
  }

  function showStatus() {
    const text =
      shown._tag === "Other" && !dataMaps.has(shown.mapId)
        ? (shown.error ?? "Loading…")
        : actionStatus;
    mapStatus.hidden = !text;
    mapStatus.textContent = text;
  }

  function setStatus(text: string) {
    actionStatus = text;
    showStatus();
  }

  fillLegend(get("legend"), sprites);

  function select(next: Selection) {
    selection = next;
    panel.forgetBlocks();
  }
  const selectedEvent = () => (selection?._tag === "Event" ? selection.id : undefined);
  const selectedTile = () => (selection?._tag === "Tile" ? selection : undefined);
  function updateRows() {
    if (!snapshot) return;
    const key = JSON.stringify([
      snapshot.mapId,
      snapshot.markers.map(({ id, name, trigger, state }) => [id, name, trigger, state]),
      filter.checked,
    ]);
    if (key !== rowsKey) {
      rowsKey = key;
      events.replaceChildren();
      for (const marker of snapshot.markers) {
        if (filter.checked && marker.state !== "active") continue;
        const row = document.createElement("button");
        row.dataset.id = String(marker.id);
        row.setAttribute("aria-pressed", String(selectedEvent() === marker.id));
        row.append(`${marker.id} ${marker.name}`);
        const words = document.createElement("small");
        words.textContent = markerSummary(marker);
        row.append(words);
        row.onclick = () => select({ _tag: "Event", id: marker.id });
        events.append(row);
      }
    }
    for (const row of events.querySelectorAll<HTMLButtonElement>("button")) {
      const pressed = String(Number(row.dataset.id) === selectedEvent());
      if (row.getAttribute("aria-pressed") !== pressed) row.setAttribute("aria-pressed", pressed);
    }
    const marker = snapshot.markers.find((event) => event.id === selectedEvent());
    if (!marker) return panel.show(undefined);
    const mapId = snapshot.mapId;
    let found: Omit<EventDetail, "marker" | "mapId" | "otherMap"> | undefined;
    if (shown._tag === "Other") {
      const otherMap = shown.mapId;
      const dataEvent = dataMaps
        .get(otherMap)
        ?.events.find((event, index) => event && (event.id ?? index) === marker.id);
      if (dataEvent)
        found = {
          pages: dataEventPages(game, otherMap, marker.id, dataEvent),
          lists: dataEvent.pages.map((page) => page.list),
          position: () => dataEvent,
        };
    } else {
      const liveEvent = game.$gameMap?.events().find((event) => event.eventId() === marker.id);
      if (liveEvent)
        found = {
          pages: eventPages(game, liveEvent),
          lists: liveEvent.event().pages.map((page) => page.list),
          position: () => liveEvent,
        };
    }
    // An event the map doesn't have yet keeps what the panel showed.
    if (!found) return;
    const { position } = found;
    panel.show({
      ...found,
      marker,
      mapId,
      otherMap: shown._tag === "Other",
      position: () => snapshot?.markers.find((event) => event.id === marker.id) ?? position(),
    });
  }
  function mapEntries() {
    const infos = game.$dataMapInfos ?? [];
    const entries = infos
      .map((info, id) => (info ? { id, info } : undefined))
      .filter(
        (entry): entry is { id: number; info: NonNullable<(typeof infos)[number]> } => !!entry,
      )
      .toSorted((a, b) => (a.info.order ?? a.id) - (b.info.order ?? b.id));
    return entries.map(({ id, info }) => {
      let depth = 0;
      const seen = new Set<number>();
      let parent = info.parentId ?? 0;
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        depth++;
        parent = infos[parent]?.parentId ?? 0;
      }
      return { id, name: info.name, depth };
    });
  }
  function updatePicker(playerMapId: number) {
    const entries = mapEntries();
    const shownMapId = shown._tag === "Other" ? shown.mapId : playerMapId;
    const key = JSON.stringify([entries, shownMapId]);
    if (key === pickerKey) return;
    pickerKey = key;
    picker.replaceChildren();
    for (const entry of entries) {
      const option = document.createElement("option");
      option.value = String(entry.id);
      option.textContent = `${"\u00a0\u00a0".repeat(entry.depth)}${entry.id} ${entry.name}`;
      picker.append(option);
    }
    picker.value = String(shownMapId);
  }
  function loadDataMap(mapId: number) {
    if (dataMaps.has(mapId) || loadingMaps.has(mapId)) return;
    const request = new Promise<DataMap>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", `data/Map${String(mapId).padStart(3, "0")}.json`);
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(`HTTP ${xhr.status || "unknown error"}`));
          return;
        }
        try {
          const value = JSON.parse(xhr.responseText);
          if (!value || typeof value !== "object") throw new Error("The response was not a map.");
          resolve(value as DataMap);
        } catch (error) {
          reject(error);
        }
      };
      xhr.onerror = () => reject(new Error("The request failed."));
      xhr.send();
    });
    loadingMaps.set(mapId, request);
    void request.then(
      (map) => {
        loadingMaps.delete(mapId);
        dataMaps.set(mapId, map);
        if (shown._tag === "Other" && shown.mapId === mapId) {
          fitNext = true;
          if (!host.hidden) draw();
        }
      },
      (error: unknown) => {
        loadingMaps.delete(mapId);
        if (shown._tag !== "Other" || shown.mapId !== mapId) return;
        shown = {
          ...shown,
          error: `Unable to load map ${mapId}: ${error instanceof Error ? error.message : String(error)}`,
        };
        if (!host.hidden) draw();
      },
    );
  }
  function updateTileAction() {
    const chosenTile = selectedTile();
    if (!chosenTile || !snapshot) {
      tileSelection.textContent = "Click a tile or an event";
      teleportTileButton.disabled = true;
      return;
    }
    const mapName = game.$dataMapInfos?.[snapshot.mapId]?.name;
    const mapPrefix =
      shown._tag === "Other" ? `Map ${snapshot.mapId}${mapName ? ` "${mapName}"` : ""} · ` : "";
    tileSelection.textContent = `${mapPrefix}Tile ${chosenTile.x}, ${chosenTile.y} · ${tileDescription(snapshot, chosenTile.x, chosenTile.y)}`;
    teleportTileButton.disabled = !game.$gameMap || !game.$gamePlayer;
  }
  function teleportTo(x: number, y: number) {
    if (!snapshot) return;
    const target = teleportTarget(snapshot, x, y);
    if (!target) {
      setStatus("There is no passable tile on this map.");
      return;
    }
    const targetMapId = snapshot.mapId;
    const error = teleport(game, targetMapId, target.x, target.y);
    if (error) {
      setStatus(error);
    } else if (targetMapId === (game.$gameMap?.mapId() ?? 0)) {
      pendingTeleport = undefined;
      setStatus(`Moved to ${target.x}, ${target.y}`);
    } else {
      pendingTeleport = { mapId: targetMapId, x: target.x, y: target.y };
      setStatus(`Moving to Map ${targetMapId} …`);
    }
  }
  function draw() {
    const currentMapId = game.$gameMap?.mapId() ?? 0;
    let arrived: typeof pendingTeleport;
    if (pendingTeleport && !game.$gamePlayer?.isTransferring?.()) {
      // A plugin may send the transfer to another map; then the teleport is over too.
      if (currentMapId === pendingTeleport.mapId) {
        arrived = pendingTeleport;
        shown = { _tag: "Player" };
      } else actionStatus = "";
      pendingTeleport = undefined;
    }
    const nowShown =
      shown._tag === "Other"
        ? { map: undefined, mapId: shown.mapId }
        : { map: game.$gameMap, mapId: currentMapId };
    if (nowShown.map !== shownMap?.map || nowShown.mapId !== shownMap?.mapId) {
      shownMap = nowShown;
      snapshot = undefined;
      resetMapState();
    }
    if (arrived) actionStatus = `Moved to ${arrived.x}, ${arrived.y}`;
    updatePicker(currentMapId);
    back.hidden = shown._tag === "Player";
    showStatus();
    if (shown._tag === "Other") {
      const dataMap = dataMaps.get(shown.mapId);
      get("title").textContent =
        `Map ${shown.mapId}: ${dataMap?.displayName || game.$dataMapInfos?.[shown.mapId]?.name || ""}`;
      if (!dataMap) {
        if (shown.error === undefined) loadDataMap(shown.mapId);
        get("empty").hidden = true;
        get("body").hidden = true;
        rowsKey = "";
        events.replaceChildren();
        panel.show(undefined);
        return;
      }
      snapshot = dataMapSnapshot(game, shown.mapId, dataMap);
    } else {
      if (currentMapId && (!game.$dataMap || (game.DataManager && requestedMapId !== currentMapId)))
        return;
      // A few milliseconds of passability checks per frame keep large maps quick to open.
      snapshot = mapSnapshot(game, refreshGrid, performance.now() + 4);
      refreshGrid = false;
      get("title").textContent = snapshot
        ? `Map ${snapshot.mapId}: ${game.$dataMap?.displayName || game.$dataMapInfos?.[snapshot.mapId]?.name || ""}`
        : "Map view";
    }
    get("empty").hidden = !!snapshot;
    get("body").hidden = !snapshot;
    if (!snapshot) {
      tooltip.hidden = true;
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(bounds.width * ratio);
    const height = Math.round(bounds.height * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      fitNext = true;
    }
    if (fitNext) {
      ({ camera, smallest } = fit(snapshot, bounds.width, bounds.height));
      fitNext = false;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawMap(
      ctx,
      snapshot,
      camera,
      bounds,
      { event: selectedEvent(), tile: selectedTile() },
      sprites,
    );
    updateRows();
    updateTileAction();
    tooltip.hidden = true;
    if (hover) {
      const hovered = tileAt(snapshot, camera, hover.x, hover.y);
      if (hovered) {
        const marker = markerAt(snapshot, camera, sprites, hover.x, hover.y);
        tooltip.textContent = marker
          ? `${marker.id} ${nameWithOriginal(marker)} · ${markerSummary(marker)} · ${marker.x}, ${marker.y}`
          : `${hovered.x}, ${hovered.y} · ${tileDescription(snapshot, hovered.x, hovered.y)}`;
        tooltip.hidden = false;
        tooltip.style.left = `${Math.max(4, Math.min(hover.x + 12, bounds.width - tooltip.offsetWidth - 4))}px`;
        tooltip.style.top = `${Math.max(4, Math.min(hover.y + 12, bounds.height - tooltip.offsetHeight - 4))}px`;
      }
    }
  }
  function tick() {
    try {
      draw();
    } catch (error) {
      console.warn("Map view redraw failed", error);
    } finally {
      if (!host.hidden) frame = requestAnimationFrame(tick);
    }
  }
  function clearInput() {
    game.Input?.clear?.();
    game.TouchInput?.clear?.();
  }
  function close() {
    clearInput();
    host.hidden = true;
    cancelAnimationFrame(frame);
    hover = undefined;
    drag = undefined;
    tooltip.hidden = true;
  }
  function open() {
    if (!host.hidden) return;
    clearInput();
    host.hidden = false;
    // MV's Graphics.initialize sets every existing element's z-index to 0, so restore it.
    host.style.zIndex = "2147483647";
    refreshGrid = true;
    shown = { _tag: "Player" };
    fitNext = true;
    tick();
  }
  get("close").onclick = close;
  teleportTileButton.onclick = () => {
    const chosen = selectedTile();
    if (chosen) teleportTo(chosen.x, chosen.y);
  };
  function showMap(next: Shown) {
    shown = next;
    pendingTeleport = undefined;
    draw();
  }
  picker.addEventListener("change", () => {
    const mapId = Number(picker.value);
    showMap(
      mapId === (game.$gameMap?.mapId() ?? 0) ? { _tag: "Player" } : { _tag: "Other", mapId },
    );
  });
  back.onclick = () => showMap({ _tag: "Player" });
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.code === "F7") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) {
          if (host.hidden) open();
          else close();
        }
        return;
      }
      if (host.hidden) return;
      if (event.code === "Escape" || event.code === "F8") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      } else if (event.code !== "F9" && !event.composedPath().includes(host)) {
        // F9 stops a fast forward, which the F8 panel handles on `document`.
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  host.addEventListener("keydown", (event) => event.stopPropagation());
  canvas.onwheel = (event) => {
    event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left,
      y = event.clientY - bounds.top;
    const { tile, offsetX, offsetY } = camera;
    const next = Math.max(smallest, Math.min(48, tile * Math.exp(-event.deltaY * 0.001)));
    camera = {
      tile: next,
      offsetX: x - ((x - offsetX) * next) / tile,
      offsetY: y - ((y - offsetY) * next) / tile,
    };
  };
  canvas.onpointerdown = (event) => {
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    drag = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
  };
  canvas.onpointermove = (event) => {
    const bounds = canvas.getBoundingClientRect();
    hover = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    if (!drag) return;
    camera = {
      ...camera,
      offsetX: camera.offsetX + event.clientX - drag.x,
      offsetY: camera.offsetY + event.clientY - drag.y,
    };
    drag.moved ||= Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3;
    drag.x = event.clientX;
    drag.y = event.clientY;
  };
  canvas.onpointerup = (event) => {
    if (drag && !drag.moved) {
      const bounds = canvas.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const marker = snapshot && markerAt(snapshot, camera, sprites, x, y);
      if (marker) select({ _tag: "Event", id: marker.id });
      else if (snapshot) {
        const targetTile = tileAt(snapshot, camera, x, y);
        if (targetTile) select({ _tag: "Tile", ...targetTile });
      }
    }
    drag = undefined;
  };
  canvas.onpointercancel = () => {
    drag = undefined;
  };
  canvas.onpointerleave = () => {
    hover = undefined;
  };
  return { open };
}
