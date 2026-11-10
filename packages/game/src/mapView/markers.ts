import type { Marker, Trigger } from "./model.ts";
import type { Sprites } from "./sprites.ts";

/** Each trigger has its own shape, so markers stay apart without color. */
export function shape(
  pen: CanvasRenderingContext2D,
  trigger: Trigger | null,
  x: number,
  y: number,
  r: number,
) {
  pen.beginPath();
  if (trigger === "action" || trigger === null) pen.arc(x, y, r, 0, Math.PI * 2);
  else if (trigger === "player-touch") pen.rect(x - r, y - r, r * 2, r * 2);
  else {
    const sides = trigger === "event-touch" ? 4 : trigger === "autorun" ? 3 : 6;
    for (let i = 0; i < sides; i++) {
      const angle = -Math.PI / 2 + (i * Math.PI * 2) / sides;
      const px = x + Math.cos(angle) * r;
      const py = y + Math.sin(angle) * r;
      if (i) pen.lineTo(px, py);
      else pen.moveTo(px, py);
    }
    pen.closePath();
  }
}

/** A marker without its sprite: its trigger's shape, with its id in `idSize` px when given. */
export function drawMarker(
  pen: CanvasRenderingContext2D,
  marker: Marker,
  x: number,
  y: number,
  r: number,
  idSize?: number,
) {
  pen.save();
  pen.strokeStyle =
    marker.state === "active" ? "#ffb648" : marker.state === "empty" ? "#abb6c6" : "#78869b";
  pen.fillStyle = "#ffb648";
  pen.lineWidth = 1.5;
  if (marker.state === "none") {
    pen.globalAlpha = 0.55;
    pen.setLineDash([2, 2]);
  }
  shape(pen, marker.trigger, x, y, r);
  if (marker.state === "active") pen.fill();
  else pen.stroke();
  pen.setLineDash([]);
  if (idSize !== undefined) {
    pen.fillStyle = marker.state === "active" ? "#111c2e" : "#e7edf7";
    pen.font = `${idSize}px system-ui`;
    pen.textAlign = "center";
    pen.textBaseline = "middle";
    pen.fillText(String(marker.id), x, y);
  }
  if (marker.hidden) {
    pen.setLineDash([2, 2]);
    pen.beginPath();
    pen.arc(x, y, r + 3, 0, Math.PI * 2);
    pen.stroke();
  }
  pen.restore();
}

/** A marker on a tile `size` px wide centred on x, y: its sprite standing there, with a badge. */
export function drawStandingMarker(
  pen: CanvasRenderingContext2D,
  marker: Marker,
  x: number,
  y: number,
  size: number,
  sprites: Sprites,
) {
  const sprite = marker.sprite && sprites.load(marker.sprite);
  if (marker.state === "none" || (!marker.hidden && !sprite)) {
    drawMarker(pen, marker, x, y, size * 0.35, size >= 16 ? Math.min(14, size * 0.4) : undefined);
    return;
  }
  pen.save();
  const color = marker.state === "active" ? "#ffb648" : "#abb6c6";
  if (sprite) {
    const { tilesWide, tilesHigh } = sprite;
    pen.imageSmoothingEnabled = false;
    const left = x - (tilesWide * size) / 2,
      top = y + size / 2 - tilesHigh * size;
    if (marker.state === "empty")
      pen.drawImage(sprites.faded(sprite), left, top, tilesWide * size, tilesHigh * size);
    else {
      const { source, rect } = sprite;
      pen.drawImage(
        source,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        left,
        top,
        tilesWide * size,
        tilesHigh * size,
      );
    }
  } else {
    pen.strokeStyle = color;
    pen.lineWidth = 1.5;
    pen.setLineDash([2, 2]);
    pen.beginPath();
    pen.arc(x, y, size * 0.3, 0, Math.PI * 2);
    pen.stroke();
    pen.setLineDash([]);
  }
  const radius = Math.max(3, size * 0.16);
  const badgeX = x + size / 2 - radius,
    badgeY = y + size / 2 - radius;
  shape(pen, marker.trigger, badgeX, badgeY, radius + 1.5);
  pen.fillStyle = "#111c2e";
  pen.fill();
  shape(pen, marker.trigger, badgeX, badgeY, radius);
  pen.strokeStyle = color;
  pen.lineWidth = 1.5;
  if (marker.state === "active") {
    pen.fillStyle = color;
    pen.fill();
  } else pen.stroke();
  if (size >= 20) {
    pen.font = "600 10px system-ui";
    const text = String(marker.id),
      width = pen.measureText(text).width + 7;
    pen.fillStyle = "#111c2ee6";
    pen.beginPath();
    pen.roundRect(x - width / 2, y + size / 2 - 0.75, width, 13.5, 6.75);
    pen.fill();
    pen.fillStyle = "#e7edf7";
    pen.textAlign = "center";
    pen.textBaseline = "middle";
    pen.fillText(text, x, y + size / 2 + 6.5);
  }
  pen.restore();
}
