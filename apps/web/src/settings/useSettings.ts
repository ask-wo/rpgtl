import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Settings } from "@rpgtl/contracts";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useEffect, useRef, useState } from "react";
import { failureMessage } from "../app/failure.ts";
import { saveSettings, settings, settingsKey } from "./atoms.ts";

/**
 * The shared settings, with each change shown at once and saved in the order it was made;
 * `error` says why the last save failed, and the server's settings show again then.
 */
export const useSettings = () => {
  const saved = useAtomValue(settings);
  const update = useAtomSet(saveSettings, { mode: "promiseExit" });
  const [wanted, setWanted] = useState<Settings>();
  const [error, setError] = useState<string>();
  const queue = useRef<Promise<void>>(Promise.resolve());
  const going = useRef(0);

  // A change made from the server's settings while an earlier one was still on its way would
  // send that earlier setting back, so changes build on `wanted` until the server has them all.
  useEffect(() => {
    if (going.current === 0) setWanted(undefined);
  }, [saved]);

  const save = (next: Settings) => {
    setWanted(next);
    setError(undefined);
    going.current += 1;
    queue.current = queue.current.then(async () => {
      const exit = await update({ payload: next, reactivityKeys: [settingsKey] });
      going.current -= 1;
      if (Exit.isFailure(exit)) {
        setError(failureMessage(exit.cause));
        if (going.current === 0) setWanted(undefined);
      }
    });
  };
  const shown = wanted === undefined ? saved : AsyncResult.map(saved, () => wanted);
  return { settings: shown, save, error };
};
