import { test, expect } from "vite-plus/test";
import { loadRuntime } from "../testUtils/fixture.ts";

// A map scene whose event shows messages until `game` says a choice or free movement comes.
async function skipGame() {
  class Scene_Map {
    name = "map";
  }
  class Scene_Battle {
    name = "battle";
  }
  const game = {
    updates: 0,
    choice: false,
    eventRunning: true,
    changingScene: false,
    inputting: false,
    // Milliseconds each update takes on the fake clock.
    updateCost: 0,
  };
  let now = 0;
  let nextFrame: (() => void)[] = [];
  const SceneManager = {
    _scene: new Scene_Map() as object,
    run() {},
    updateInputData() {},
    isSceneChanging: () => game.changingScene,
    updateScene() {
      game.updates++;
      now += game.updateCost;
    },
  };
  const runtime = await loadRuntime("MZ", {
    SceneManager,
    Scene_Map,
    Scene_Battle,
    BattleManager: { isInputting: () => game.inputting },
    $gameMessage: {
      isChoice: () => game.choice,
      isNumberInput: () => false,
      isItemChoice: () => false,
    },
    $gamePlayer: { canMove: () => !game.eventRunning },
    requestAnimationFrame: (callback: () => void) => nextFrame.push(callback),
    performance: { now: () => now },
  });
  // A drawn frame, in which the engine calls updateScene once, or `catchUp` times when it is late.
  const frame = (catchUp = 1) => {
    const callbacks = nextFrame;
    nextFrame = [];
    for (const callback of callbacks) callback();
    game.updates = 0;
    for (let call = 0; call < catchUp; call++) SceneManager.updateScene();
    return game.updates;
  };
  return { ...runtime, game, frame, SceneManager, Scene_Battle };
}

test("runtime F9 skips messages at ten updates a frame until a choice shows", async () => {
  const { message, press, game, frame } = await skipGame();
  expect(message.isTriggered()).toBe(false);
  expect(frame()).toBe(1);

  press("F9");
  expect(message.isTriggered()).toBe(true);
  expect(frame()).toBe(10);
  game.choice = true;
  expect(frame()).toBe(1);
  expect(message.isTriggered()).toBe(false);
});

test("runtime F9 stops skipping when the player can move, and when pressed again", async () => {
  const { message, press, game, frame } = await skipGame();
  press("F9");
  game.eventRunning = false;
  expect(frame()).toBe(1);
  expect(message.isTriggered()).toBe(false);

  // Nothing runs, so F9 doesn't start a skip.
  press("F9");
  expect(message.isTriggered()).toBe(false);

  game.eventRunning = true;
  press("F9");
  expect(message.isTriggered()).toBe(true);
  press("F9");
  expect(message.isTriggered()).toBe(false);
});

test("runtime F9 skip waits out scene changes and stops at battle commands", async () => {
  const { message, press, game, frame, SceneManager, Scene_Battle } = await skipGame();
  press("F9");
  game.changingScene = true;
  expect(frame()).toBe(1);
  expect(message.isTriggered()).toBe(true);

  game.changingScene = false;
  SceneManager._scene = new Scene_Battle();
  expect(frame()).toBe(10);
  game.inputting = true;
  expect(frame()).toBe(1);
  expect(message.isTriggered()).toBe(false);
});

test("runtime F9 skips once per drawn frame, so the engine's catch-up updates don't skip too", async () => {
  const { press, frame } = await skipGame();
  press("F9");
  expect(frame(3)).toBe(12);
  expect(frame()).toBe(10);
});

test("runtime F9 skip stops a frame's extra updates once they took 8 milliseconds", async () => {
  const { press, game, frame } = await skipGame();
  game.updateCost = 3;
  press("F9");
  expect(frame()).toBe(4);
});
