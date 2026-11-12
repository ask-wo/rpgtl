import { type Battler, rm } from "./engine.ts";

// A request's effect shows only in a later `cheatState()`; its answer is only a refusal.

interface CheatActor {
  id: number;
  level: number;
  maxLevel: number;
}

export interface CheatState {
  /** Null outside a battle. `canEnd` is false once it ends. */
  battle: { canEnd: boolean; canLose: boolean } | null;
  actors: CheatActor[];
  /** A message or choice is open. A level-up message would be lost in it. */
  messageOpen: boolean;
  /** The game's own option: dash unless Shift is held. */
  alwaysDash: boolean;
  /** Dashing works also on maps that turn it off. */
  dashOnEveryMap: boolean;
}

export type CheatRequest =
  | { type: "winBattle" }
  | { type: "loseBattle" }
  | { type: "levelUp"; actorId: number }
  | { type: "setAlwaysDash"; on: boolean }
  | { type: "setDashOnEveryMap"; on: boolean };

let dashOnEveryMap = false;

export function hookCheats() {
  const map = rm.Game_Map?.prototype;
  if (!map) return;
  const isDashDisabled = map.isDashDisabled;
  map.isDashDisabled = function () {
    return !dashOnEveryMap && isDashDisabled.call(this);
  };
}

const battlePhases = new Set(["start", "input", "turn", "action", "turnEnd"]);

/** The current state, or null before a new game starts or a save loads. */
export function cheatState(): CheatState | null {
  const party = rm.$gameParty;
  if (!party || !rm.$gamePlayer || !party.members().length) return null;
  // Reading `_data` instead of calling `actor` keeps actors the game hasn't used out of its saves.
  const actors = (rm.$dataActors ?? []).flatMap((data, id): CheatActor[] => {
    if (!data) return [];
    const actor = rm.$gameActors._data[id];
    return actor
      ? [{ id, level: actor.level, maxLevel: actor.maxLevel() }]
      : [{ id, level: data.initialLevel, maxLevel: data.maxLevel }];
  });
  const manager = rm.BattleManager;
  return {
    battle:
      manager && party.inBattle()
        ? { canEnd: battlePhases.has(manager._phase ?? ""), canLose: manager.canLose() }
        : null,
    actors,
    messageOpen: rm.$gameMessage?.isBusy?.() ?? false,
    alwaysDash: rm.ConfigManager.alwaysDash,
    dashOnEveryMap,
  };
}

// Through the battler's own death, so the battle ends as if the fight was won or lost. A battler
// that resists death gets the death state all the same.
function defeat(side: { aliveMembers(): Battler[] }) {
  for (const member of side.aliveMembers()) {
    member.setHp(0);
    if (member.isAlive()) member.addNewState(member.deathStateId());
    member.performCollapse();
  }
}

/** Why a request can't run in a state, or undefined when it can. */
export function refusal(state: CheatState | null, request: CheatRequest): string | undefined {
  if (!state) return "Start a new game or load a save first.";
  switch (request.type) {
    case "winBattle":
    case "loseBattle":
      return state.battle?.canEnd ? undefined : "Only in battle.";
    case "levelUp": {
      const actor = state.actors.find(({ id }) => id === request.actorId);
      if (!actor) return "Select an actor.";
      if (actor.level >= actor.maxLevel) return "Highest level.";
      // MV closes the command windows of a battle while a message shows, and while the player
      // picks commands nothing opens them again.
      if (state.battle) return "Only outside battle.";
      if (state.messageOpen) return "Wait until the message closes.";
      return;
    }
    case "setAlwaysDash":
    case "setDashOnEveryMap":
      return;
  }
}

export function requestCheat(request: CheatRequest): string | undefined {
  const refused = refusal(cheatState(), request);
  if (refused) return refused;
  switch (request.type) {
    case "winBattle":
    case "loseBattle": {
      const side = request.type === "winBattle" ? rm.$gameTroop : rm.$gameParty;
      if (side) defeat(side);
      // While the player picks commands, nothing checks for the end of the battle.
      if (rm.BattleManager?._phase === "input") rm.BattleManager.checkBattleEnd();
      return;
    }
    case "levelUp": {
      const actor = rm.$gameActors.actor(request.actorId);
      actor?.changeLevel(actor.level + 1, true);
      return;
    }
    case "setAlwaysDash":
      rm.ConfigManager.alwaysDash = request.on;
      rm.ConfigManager.save();
      return;
    case "setDashOnEveryMap":
      dashOnEveryMap = request.on;
      return;
  }
}
