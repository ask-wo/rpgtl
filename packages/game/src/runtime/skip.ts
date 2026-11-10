import { rm } from "./engine.ts";

// F9's fast forward: messages show at once and close by themselves, and the game runs up to
// `skipFrames` updates per drawn frame, until the player has a decision to make.
const skipFrames = 10;
// A drawn frame that comes late makes MV and MZ catch up with more updates in the next one. If each
// of those skipped too, every late frame would make the next one later.
const skipBudgetMs = 8;
let skippedThisFrame = false;
let skipping = false;
let skipListener: (() => void) | undefined;
export const isSkipping = () => skipping;
export function onSkipChange(listener: () => void) {
  skipListener = listener;
}
export function setSkipping(on: boolean) {
  skipping = on;
  skipListener?.();
}

// A choice, number or item input, the battle commands, the player free to move on the map, or
// any other scene, such as a menu, a shop or the title screen.
export function atDecision() {
  const { SceneManager, $gameMessage: message } = rm;
  if (SceneManager?.isSceneChanging?.()) return false;
  if (message?.isChoice() || message?.isNumberInput() || message?.isItemChoice()) return true;
  const scene = SceneManager?._scene;
  if (rm.Scene_Battle && scene instanceof rm.Scene_Battle) return !!rm.BattleManager?.isInputting();
  if (rm.Scene_Map && scene instanceof rm.Scene_Map) return !!rm.$gamePlayer?.canMove();
  return true;
}

export function hookSkip() {
  const message = rm.Window_Message?.prototype;
  if (message) {
    const isTriggered = message.isTriggered;
    message.isTriggered = function () {
      return skipping || isTriggered.call(this);
    };
  }
  for (const proto of [rm.Window_ScrollText?.prototype, rm.Window_BattleLog?.prototype]) {
    if (!proto) continue;
    const isFastForward = proto.isFastForward;
    proto.isFastForward = function () {
      return skipping || isFastForward.call(this);
    };
  }
  const manager = rm.SceneManager!;
  const updateScene = manager.updateScene;
  if (!updateScene) return;
  manager.updateScene = function () {
    updateScene.call(this);
    if (skipping && atDecision()) setSkipping(false);
    if (!skipping || skippedThisFrame) return;
    skippedThisFrame = true;
    rm.requestAnimationFrame(() => (skippedThisFrame = false));
    const end = rm.performance.now() + skipBudgetMs;
    for (let frame = 1; frame < skipFrames && skipping; frame++) {
      if (this.isSceneChanging?.() || rm.performance.now() >= end) break;
      this.updateInputData?.();
      updateScene.call(this);
      if (atDecision()) setSkipping(false);
    }
  };
}
