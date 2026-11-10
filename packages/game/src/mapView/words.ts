import { blockedSides, tileLook } from "./model.ts";
import type { MapSnapshot, Marker, Priority, Trigger } from "./model.ts";

export const triggerWords: Record<Trigger, string> = {
  action: "Action button",
  "player-touch": "Player touch",
  "event-touch": "Event touch",
  autorun: "Autorun",
  parallel: "Parallel",
};
export const priorityWords: Record<Priority, string> = {
  below: "Below characters",
  same: "Same as characters",
  above: "Above characters",
};
const stateWords = {
  active: "Has commands",
  empty: "No commands",
  none: "No applicable page",
};
const directionWords: Record<number, string> = { 2: "down", 4: "left", 6: "right", 8: "up" };

export const nameWithOriginal = (marker: Marker) =>
  marker.originalName ? `${marker.name} (${marker.originalName})` : marker.name;

export const markerSummary = (marker: Marker) =>
  `${marker.trigger ? triggerWords[marker.trigger] : "No trigger"} · ${stateWords[marker.state]}`;

export function tileDescription(snapshot: MapSnapshot, x: number, y: number) {
  const look = tileLook(snapshot, x, y);
  const blocked = blockedSides(snapshot, x, y).map((direction) => directionWords[direction]);
  return look === "floor" && blocked.length ? `${look}, blocked: ${blocked.join(", ")}` : look;
}
