import { gameId, rm } from "./engine.ts";
import { playedTime } from "./playedTime.ts";

const reportEvery = 30;

function record(seconds: number) {
  if (rm.rpgtlRecordPlaytime) return rm.rpgtlRecordPlaytime(seconds);
  if (!gameId) return;
  void fetch(`/playtime/${gameId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seconds }),
    // The last report is sent while the page closes.
    keepalive: true,
  }).catch(() => {});
}

export function hookPlaytime() {
  const clock = playedTime(performance.now());
  const input = () => clock.input(performance.now());
  for (const type of ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"])
    document.addEventListener(type, input, { capture: true, passive: true });
  // Gamepads fire no events; the engine polls them in Input.update.
  const { Input } = rm;
  const update = Input?.update;
  if (Input && update)
    Input.update = function () {
      update.call(Input);
      if (Input._latestButton) input();
    };
  const report = () => {
    const seconds = clock.take();
    if (seconds > 0) record(seconds);
  };
  let ticks = 0;
  setInterval(() => {
    clock.tick(performance.now(), document.hasFocus());
    if (++ticks % reportEvery === 0) report();
  }, 1000);
  rm.addEventListener("pagehide", report);
}
