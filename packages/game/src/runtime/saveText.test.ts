import type { Entry } from "@rpgtl/contracts";
import { test, expect } from "vite-plus/test";
import { appliedSystem, loadRuntime } from "../testUtils/fixture.ts";

const variableTextEntry = (source: string, translation: string): Entry => ({
  id: source,
  file: "CommonEvents.json",
  path: ["1", "list", "0", "parameters", "0", "variableText", "0"],
  source,
  translation: translation ? { user: translation } : {},
});

test("runtime translates text that a save stored before it was translated", async () => {
  const system = appliedSystem([
    variableTextEntry("人类", "Human"),
    variableTextEntry("猫娘", ""),
    {
      id: "a",
      file: "Actors.json",
      path: ["1", "name"],
      source: "优斗",
      translation: { user: "Yuto" },
    },
    {
      id: "b",
      file: "Map001.json",
      path: ["events", "1", "pages", "0", "list", "3", "parameters", "1"],
      source: "小优",
      translation: { user: "Little Yuto" },
    },
  ]);
  expect(system.rpgtlSaveText).toEqual({ 人类: "Human", 优斗: "Yuto", 小优: "Little Yuto" });
  const stored: Record<number, unknown> = { 1: "人类", 2: "猫娘", 3: 7, 4: "constructor" };
  class Game_Variables {
    value(id: number) {
      return stored[id];
    }
  }
  class Game_Actor {
    name() {
      return "优斗";
    }
    nickname() {
      return "小优";
    }
    profile() {
      return "";
    }
  }
  await loadRuntime("MZ", { Game_Variables, Game_Actor, $dataSystem: system });
  const variables = new Game_Variables();
  expect([1, 2, 3, 4].map((id) => variables.value(id))).toEqual([
    "Human",
    "猫娘",
    7,
    "constructor",
  ]);
  const actor = new Game_Actor();
  expect([actor.name(), actor.nickname(), actor.profile()]).toEqual(["Yuto", "Little Yuto", ""]);
});
