import { RegistryContext } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { useContext } from "react";
import { invalidateCatalog } from "../translation/atoms.ts";

/** Whether the game's edits are all saved, and why the last save failed. */
export interface EditsStatus {
  readonly saving: boolean;
  readonly error: string | undefined;
}

export const editsStatus = Atom.family((_id: string) =>
  Atom.make<EditsStatus>({ saving: false, error: undefined }).pipe(Atom.keepAlive),
);

/** Writes one edit; gives why it failed, or nothing once it is saved. */
type Save = () => Promise<string | undefined>;

/**
 * Once no save is running or waiting, every query keyed on `catalogKey` is read again, so a save
 * needs no `reactivityKeys` of its own.
 */
export interface GameEdits {
  /**
   * Saves after `delay` ms without a newer save of the same `key`, which replaces it, so typing
   * saves once it pauses.
   */
  readonly schedule: (key: string, save: Save, delay: number) => void;
  /** Saves now, after the saves before it; gives why it failed. */
  readonly run: (save: Save) => Promise<string | undefined>;
  /**
   * Starts the scheduled saves now, waits until every save has finished, and gives why a
   * scheduled save failed, while its edit is unsaved.
   */
  readonly flush: () => Promise<string | undefined>;
  /** Drops the edit saved under `key`, whether still scheduled or failed, once the page drops it. */
  readonly discard: (key: string) => void;
}

const queues = new WeakMap<AtomRegistry.AtomRegistry, Map<string, GameEdits>>();

/**
 * The game's saves, one at a time and in order, as the server holds the game for each write. Once
 * the last one finished, every query keyed on the game's catalog is read again.
 */
function gameEdits(registry: AtomRegistry.AtomRegistry, id: string): GameEdits {
  // Mounted, so the registry can't drop the unread atom while its Effect still runs.
  registry.mount(invalidateCatalog);
  const scheduled = new Map<string, { save: Save; timer: ReturnType<typeof setTimeout> }>();
  let last: Promise<unknown> = Promise.resolve();
  let pending = 0;
  // Why each key's last scheduled save failed: its edit is still unsaved.
  const unsaved = new Map<string, string>();
  // Counts each key's discards, so a save that was running when its edit was discarded can't
  // report its failure afterwards.
  const discarded = new Map<string, number>();

  const status = (change: Partial<EditsStatus>) =>
    registry.set(editsStatus(id), {
      ...registry.get(editsStatus(id)),
      saving: pending > 0 || scheduled.size > 0,
      ...change,
    });

  const run = (save: Save) => {
    pending += 1;
    status({});
    const done = last.then(save).then((error) => {
      pending -= 1;
      status({ error });
      if (pending === 0 && scheduled.size === 0) registry.set(invalidateCatalog, id);
      return error;
    });
    last = done;
    return done;
  };

  const start = (key: string) => {
    const waiting = scheduled.get(key);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    scheduled.delete(key);
    const since = discarded.get(key);
    void run(waiting.save).then((error) => {
      if (discarded.get(key) !== since) return;
      if (error) unsaved.set(key, error);
      else unsaved.delete(key);
      // Another edit's failed save still leaves the game with an unsaved edit.
      status({ error: error ?? unsaved.values().next().value });
    });
  };

  return {
    schedule: (key, save, delay) => {
      clearTimeout(scheduled.get(key)?.timer);
      scheduled.set(key, { save, timer: setTimeout(() => start(key), delay) });
      status({});
    },
    run,
    flush: async () => {
      for (const key of scheduled.keys()) start(key);
      await last;
      return unsaved.values().next().value;
    },
    discard: (key) => {
      clearTimeout(scheduled.get(key)?.timer);
      scheduled.delete(key);
      unsaved.delete(key);
      discarded.set(key, (discarded.get(key) ?? 0) + 1);
      status({});
    },
  };
}

/** The open game's save queue, shared by every part of its page. */
export function useGameEdits(id: string): GameEdits {
  const registry = useContext(RegistryContext);
  let games = queues.get(registry);
  if (!games) queues.set(registry, (games = new Map()));
  let edits = games.get(id);
  if (!edits) games.set(id, (edits = gameEdits(registry, id)));
  return edits;
}
