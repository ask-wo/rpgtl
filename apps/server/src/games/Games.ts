import { Engine, type Game, Games as GameList, type SavedGame } from "@rpgtl/contracts";
import { type EngineFeatures, engineFeatures, otherVersions } from "@rpgtl/domain";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Ref from "effect/Ref";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as StateFolder from "../state/StateFolder.ts";

export class GameNotInspectedError extends Schema.TaggedError<GameNotInspectedError>()(
  "GameNotInspectedError",
  { id: Schema.String },
) {
  override get message() {
    return `Game ${this.id} hasn't been inspected.`;
  }
}

/** Something RPGTL can't do yet for games of the game's engine, such as the audit's coverage checks for XP games. */
export class EngineUnsupportedError extends Schema.TaggedError<EngineUnsupportedError>()(
  "EngineUnsupportedError",
  {
    id: Schema.String,
    engine: Engine,
    feature: Schema.Literals(["play", "gameScripts", "imageText", "coverage"]),
  },
) {
  override get message() {
    return `RPGTL can't do this for ${this.engine} games yet (game ${this.id}).`;
  }
}

/** Fails unless RPGTL can do `feature` for the game's engine. */
export const requireFeature = (game: Game, feature: keyof EngineFeatures) =>
  engineFeatures[game.engine][feature]
    ? Effect.void
    : Effect.fail(new EngineUnsupportedError({ id: game.id, engine: game.engine, feature }));

/** Another operation on the game holds it, such as a run or a save. */
export class GameBusyError extends Schema.TaggedError<GameBusyError>()("GameBusyError", {
  id: Schema.String,
}) {
  override get message() {
    return "Another operation holds this game, such as an import. Try again once it has finished.";
  }
}

const listFile = "games.json";

/** The games the list shows, without the removed ones. */
const shown = (all: ReadonlyArray<SavedGame>): ReadonlyArray<Game> =>
  all.filter((game) => !game.removed);

/**
 * The inspected games, as `games.json` lists them, and which of them an operation holds. A game
 * keeps the random id it got when first opened, whatever folder or version it is in later.
 */
export class Games extends Context.Service<
  Games,
  {
    readonly list: Effect.Effect<ReadonlyArray<Game>>;
    readonly get: (id: string) => Effect.Effect<Game, GameNotInspectedError>;
    /** The id of the game saved for the web folder, whether it is listed or was removed. */
    readonly idAt: (webRoot: string) => Effect.Effect<Option.Option<string>>;
    /** A random id for a new game that no saved game has. */
    readonly newId: Effect.Effect<string>;
    /**
     * The saved games in other folders, listed or removed, that `found` seems to be another
     * version of, the surest first.
     */
    readonly otherVersions: (
      found: Omit<Game, "id">,
    ) => Effect.Effect<ReadonlyArray<{ readonly game: SavedGame; readonly sure: boolean }>>;
    /**
     * Replaces the game with its id in place, or adds it to the end of the list, also when it was
     * removed.
     */
    readonly save: (game: Game) => Effect.Effect<void, StateFolder.StateFileError>;
    /**
     * Removes the game from the list; `games.json` keeps it, marked, so opening its folder again
     * finds its state. Fails while the game is held or a run of it waits.
     */
    readonly forget: (
      id: string,
    ) => Effect.Effect<
      ReadonlyArray<Game>,
      GameNotInspectedError | GameBusyError | StateFolder.StateFileError
    >;
    /**
     * Keeps the game in the list until the scope closes, without holding it, for a run that waits
     * for its turn and must stay stoppable.
     */
    readonly keep: (id: string) => Effect.Effect<void, never, Scope.Scope>;
    /** Holds the game until the scope closes, and fails at once when another operation holds it. */
    readonly hold: (id: string) => Effect.Effect<void, GameBusyError, Scope.Scope>;
    /** Runs `effect` holding the game, and fails at once when another operation holds it. */
    readonly exclusive: <A, E, R>(
      id: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | GameBusyError, R>;
  }
>()("@rpgtl/server/games/Games") {}

const make = Effect.gen(function* () {
  const folder = yield* StateFolder.StateFolder;
  const saved = yield* folder.read(listFile, GameList);
  const games = yield* SynchronizedRef.make(
    Option.getOrElse(saved, (): ReadonlyArray<SavedGame> => []),
  );
  const held = yield* Ref.make(HashSet.empty<string>());
  const kept = yield* Ref.make(HashMap.empty<string, number>());
  const random = yield* SecureRandom.SecureRandom;

  const list = Effect.map(SynchronizedRef.get(games), shown);
  const get = Effect.fn("Games.get")(function* (id: string) {
    const game = (yield* list).find((listed) => listed.id === id);
    if (!game) return yield* new GameNotInspectedError({ id });
    return game;
  });
  const update = Effect.fn("Games.update")(function* (
    change: (list: ReadonlyArray<SavedGame>) => ReadonlyArray<SavedGame>,
  ) {
    return yield* SynchronizedRef.updateAndGetEffect(games, (current) => {
      const next = change(current);
      return folder.write(listFile, GameList, next).pipe(Effect.as(next));
    });
  });

  const hold = Effect.fn("Games.hold")(function* (id: string) {
    yield* Effect.acquireRelease(
      Ref.modify(held, (ids) =>
        HashSet.has(ids, id) ? [false, ids] : [true, HashSet.add(ids, id)],
      ).pipe(
        Effect.filterOrFail(
          (taken) => taken,
          () => new GameBusyError({ id }),
        ),
      ),
      () => Ref.update(held, HashSet.remove(id)),
    );
  });
  const exclusive = Effect.fn("Games.exclusive")(function* <A, E, R>(
    id: string,
    effect: Effect.Effect<A, E, R>,
  ) {
    return yield* Effect.scoped(Effect.andThen(hold(id), effect));
  });

  const idAt = Effect.fn("Games.idAt")(function* (webRoot: string) {
    const known = (yield* SynchronizedRef.get(games)).find((game) => game.webRoot === webRoot);
    return Option.fromUndefinedOr(known?.id);
  });
  const newId = Effect.gen(function* () {
    const taken = new Set((yield* SynchronizedRef.get(games)).map((game) => game.id));
    for (;;) {
      const bytes = yield* random.randomBytes(10);
      const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (!taken.has(id)) return id;
    }
  }).pipe(Effect.withSpan("Games.newId"));
  const otherVersionsOf = Effect.fn("Games.otherVersions")(function* (found: Omit<Game, "id">) {
    return otherVersions(found, yield* SynchronizedRef.get(games));
  });

  const save = Effect.fn("Games.save")(function* (game: Game) {
    yield* update((current) => {
      const before = current.find((other) => other.id === game.id);
      return before && !before.removed
        ? current.map((other) => (other.id === game.id ? game : other))
        : [...current.filter((other) => other.id !== game.id), game];
    });
  });
  const keep = Effect.fn("Games.keep")(function* (id: string) {
    const change = (by: number) =>
      Ref.update(kept, (ids) => {
        const count = Option.getOrElse(HashMap.get(ids, id), () => 0) + by;
        return count === 0 ? HashMap.remove(ids, id) : HashMap.set(ids, id, count);
      });
    yield* Effect.acquireRelease(change(1), () => change(-1));
  });
  const forget = Effect.fn("Games.forget")(function* (id: string) {
    yield* get(id);
    if (HashMap.has(yield* Ref.get(kept), id)) return yield* new GameBusyError({ id });
    const all = yield* exclusive(
      id,
      update((current) =>
        current.map((game) => (game.id === id ? { ...game, removed: true as const } : game)),
      ),
    );
    return shown(all);
  });

  return Games.of({
    keep,
    list,
    get,
    idAt,
    newId,
    otherVersions: otherVersionsOf,
    save,
    forget,
    hold,
    exclusive,
  });
});

export const layer = Layer.effect(Games, make).pipe(Layer.provide(SecureRandom.layerWebCrypto));
