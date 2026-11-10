import { blockedColor, tileColors } from "./canvas.ts";
import { drawMarker, drawStandingMarker, shape } from "./markers.ts";
import type { Marker, Trigger } from "./model.ts";
import type { Sprites } from "./sprites.ts";
import { triggerWords } from "./words.ts";

function item(word: string, draw: (pen: CanvasRenderingContext2D) => void) {
  const span = document.createElement("span");
  const icon = document.createElement("canvas");
  icon.width = icon.height = 22;
  draw(icon.getContext("2d")!);
  span.append(icon, word);
  return span;
}

export function fillLegend(legend: HTMLElement, sprites: Sprites) {
  for (const [word, look, blocked] of [
    ["Void", "void", false],
    ["Wall", "wall", false],
    ["Floor", "floor", false],
    ["Blocked side", "floor", true],
  ] as const)
    legend.append(
      item(word, (pen) => {
        pen.fillStyle = tileColors[look];
        pen.fillRect(2, 2, 18, 18);
        if (blocked) {
          pen.strokeStyle = blockedColor;
          pen.lineWidth = 3;
          pen.beginPath();
          pen.moveTo(2, 3.5);
          pen.lineTo(20, 3.5);
          pen.stroke();
        }
      }),
    );
  for (const [trigger, word] of Object.entries(triggerWords) as [Trigger, string][])
    legend.append(
      item(word, (pen) => {
        shape(pen, trigger, 11, 11, 8);
        pen.fillStyle = "#ffb648";
        pen.fill();
      }),
    );
  for (const [word, state, hidden] of [
    ["Has commands", "active", false],
    ["No commands", "empty", false],
    ["No applicable page", "none", false],
    ["No sprite", "active", true],
  ] as const) {
    const marker: Marker = {
      id: 0,
      name: "",
      x: 0,
      y: 0,
      trigger: "action",
      state,
      hidden,
      blocks: false,
    };
    legend.append(
      item(word, (pen) => {
        if (hidden) drawStandingMarker(pen, marker, 11, 11, 18, sprites);
        else drawMarker(pen, marker, 11, 11, 6);
      }),
    );
  }
  const player = document.createElement("span");
  player.textContent = "● Player (green) · Labelled squares: vehicles";
  legend.append(player);
}
