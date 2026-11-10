import { test, expect } from "vite-plus/test";
import { loadRuntime } from "../testUtils/fixture.ts";

test("runtime Save game opens the save screen from the map, even where the game turns saving off", async () => {
  class Scene_Map {
    name = "map";
  }
  class Scene_Save {
    name = "save";
  }
  const pushed: unknown[] = [];
  const game = { busy: true, scene: new Scene_Map() as object };
  const SceneManager = {
    get _scene() {
      return game.scene;
    },
    run() {},
    isSceneChanging: () => false,
    push: (scene: unknown) => pushed.push(scene),
  };
  const { click, elements } = await loadRuntime("MZ", {
    SceneManager,
    Scene_Map,
    Scene_Save,
    $gameSystem: { isSaveEnabled: () => false },
    $gameMessage: {
      isChoice: () => false,
      isNumberInput: () => false,
      isItemChoice: () => false,
      isBusy: () => game.busy,
    },
    $gamePlayer: { canMove: () => false },
    $gameParty: { members: () => [{}], gold: () => 0 },
  });
  elements.panel.hidden = false;

  click("save");
  expect(elements.status.textContent).toBe("Wait until the message or choice closes, then save.");
  game.busy = false;
  game.scene = {};
  click("save");
  expect(elements.status.textContent).toBe("Return to the map first: saving works only there.");
  expect(pushed).toEqual([]);

  game.scene = new Scene_Map();
  click("save");
  expect(pushed).toEqual([Scene_Save]);
  expect(elements.panel.hidden).toBe(true);
});

test("runtime the panel's walk-through box shows whether the player walks through when it opens", async () => {
  const player = {
    through: false,
    setThrough(value: boolean) {
      player.through = value;
    },
    isThrough: () => player.through,
    canMove: () => true,
  };
  const { press, elements } = await loadRuntime("MV", { $gamePlayer: player });
  elements.through.checked = true;
  elements.through.onchange();
  expect(player.through).toBe(true);

  // Loading a save gives the player the through flag it was saved with.
  player.through = false;
  elements.kind.value = "Items";
  press("F8");
  expect(elements.through.checked).toBe(false);
});
