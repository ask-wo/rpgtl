import { type Catalog, gameFiles, type XpFix } from "@rpgtl/contracts";
import type { RubyScript } from "@rpgtl/domain";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Catalogs from "../games/Catalogs.ts";
import * as Games from "../games/Games.ts";
import * as StateFolder from "../state/StateFolder.ts";

type ListErrors =
  | Games.GameNotInspectedError
  | Games.EngineUnsupportedError
  | StateFolder.StateFileError;

/**
 * An XP game's fixes: Ruby files in its state folder that fix bugs in the game's own scripts.
 * Play and Export patch add each one that is on to the game's scripts, after the game's own, so
 * `Game.exe` runs them too.
 */
export class XpFixes extends Context.Service<
  XpFixes,
  {
    /** The game's fixes by file name, with their first comment line and whether they are on. */
    readonly list: (id: string) => Effect.Effect<ReadonlyArray<XpFix>, ListErrors>;
    /** The code of the game's fixes that are on, by file name. */
    readonly active: (
      catalog: Catalog,
    ) => Effect.Effect<ReadonlyArray<RubyScript>, StateFolder.StateFileError>;
    readonly set: (
      id: string,
      name: string,
      on: boolean,
    ) => Effect.Effect<ReadonlyArray<XpFix>, ListErrors | Games.GameBusyError>;
  }
>()("@rpgtl/server/xpPatch/XpFixes") {}

const utf8 = new TextDecoder();

/** The first comment line of a fix, without its `#`; none when it starts with code. */
const descriptionOf = (code: string) => {
  for (const line of code.split(/\r?\n/)) {
    const text = line.trim();
    if (text === "") continue;
    return text.startsWith("#") ? text.replace(/^#+\s*/, "") : "";
  }
  return "";
};

const described = (catalog: Catalog, found: ReadonlyArray<RubyScript>) =>
  found.map(({ name, code }): XpFix => ({
    name,
    description: descriptionOf(code),
    on: !catalog.disabledFixes?.includes(name),
  }));

const make = Effect.gen(function* () {
  const state = yield* StateFolder.StateFolder;
  const games = yield* Games.Games;
  const catalogs = yield* Catalogs.Catalogs;

  const files = Effect.fnUntraced(function* (id: string) {
    const folder = gameFiles(id).xpFixes;
    const names = (yield* state.list(folder)).filter((name) => name.endsWith(".rb")).toSorted();
    return yield* Effect.forEach(names, (name) =>
      state
        .readBytes(`${folder}/${name}`)
        .pipe(Effect.map((bytes) => ({ name, code: utf8.decode(bytes) }))),
    );
  });

  const xpCatalog = Effect.fnUntraced(function* (id: string) {
    yield* Games.requireFeature(yield* games.get(id), "patch");
    return yield* catalogs.get(id);
  });

  const list = Effect.fn("XpFixes.list")(function* (id: string) {
    const catalog = yield* xpCatalog(id);
    return described(catalog, yield* files(id));
  });

  const active = Effect.fn("XpFixes.active")(function* (catalog: Catalog) {
    const found = yield* files(catalog.game.id);
    return found.filter(({ name }) => !catalog.disabledFixes?.includes(name));
  });

  const set = Effect.fn("XpFixes.set")(function* (id: string, name: string, on: boolean) {
    yield* xpCatalog(id);
    const catalog = yield* catalogs.setFix(id, name, on);
    return described(catalog, yield* files(id));
  });

  return XpFixes.of({ list, active, set });
});

export const layer = Layer.effect(XpFixes, make);
