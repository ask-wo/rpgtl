// Injected into game pages. Separates browser saves per game, wraps message text, draws translated
// title commands and the English in images, adds the F8 panel and F9's fast forward to the next choice.
import { mountPanel } from "./panel.ts";
import { gameId, rm } from "./engine.ts";
import { hookClassNames, hookHiddenText, hookItemNames, hookShortNames } from "./fittedText.ts";
import { hookImageText, hookMissingImages } from "./images.ts";
import { hookSaveText } from "./saveText.ts";
import { hookSharpPixels, hookSharpText } from "./sharpRendering.ts";
import { hookSkip } from "./skip.ts";
import { hookStretch } from "./stretch.ts";
import { hookWrapping } from "./textWrapping.ts";
import { hookTitleCommands } from "./titleCommands.ts";

function install() {
  const { SceneManager, StorageManager, Game_Player } = rm;
  if (!SceneManager || !StorageManager || !Game_Player) return false;

  // Plugins are loaded by the time the engine starts, so hook what they left in place.
  const run = SceneManager.run;
  SceneManager.run = function (this: unknown, ...args: unknown[]) {
    hookSharpPixels();
    hookSharpText();
    hookWrapping();
    hookTitleCommands();
    hookImageText();
    hookMissingImages();
    hookSaveText();
    hookShortNames();
    hookHiddenText();
    hookClassNames();
    hookItemNames();
    hookSkip();
    hookStretch();
    return run.apply(this, args);
  };

  for (const method of gameId ? ["webStorageKey", "forageKey"] : []) {
    const original = StorageManager[method];
    if (typeof original !== "function") continue;
    StorageManager[method] = function (this: unknown, ...args: unknown[]) {
      return `rpgtl-${gameId}-${original.apply(this, args)}`;
    };
  }

  mountPanel(SceneManager, Game_Player);
  return true;
}

// The engine globals appear after the game's own scripts load.
if (!install()) {
  const timer = setInterval(() => install() && clearInterval(timer), 20);
}
