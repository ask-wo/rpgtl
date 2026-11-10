import type { MapGame } from "./model.ts";
import { mountMapView } from "./view.ts";

(() => {
  const game = window as unknown as MapGame;
  function install() {
    if (!game.DataManager || !document.body) return false;
    const view = mountMapView(game);
    document.addEventListener("rpgtl-map-view", () => view.open());
    return true;
  }
  if (!install()) {
    const timer = setInterval(() => install() && clearInterval(timer), 20);
  }
})();
