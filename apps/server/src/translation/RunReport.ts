import type { AskLine, RequestLine } from "@rpgtl/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as StateFolder from "../state/StateFolder.ts";

/** What a run tells its owner while it translates; `Runs` provides one for each run. */
export class RunReport extends Context.Service<
  RunReport,
  {
    /** What the run does between translating entries, or none once it translates again. */
    readonly step: (step: string | undefined) => Effect.Effect<void>;
    /** The run moves on from the glossary pass to the text pass. */
    readonly textPass: Effect.Effect<void>;
    /** Something the user should know, such as a model running on the CPU; each is told once. */
    readonly warn: (message: string) => Effect.Effect<void>;
    readonly request: (line: Omit<RequestLine, "type" | "at">) => Effect.Effect<void>;
    readonly ask: (line: Omit<AskLine, "type" | "at">) => Effect.Effect<void>;
    /** The run's draft changed: entries were translated or given up on. */
    readonly progress: Effect.Effect<void, StateFolder.StateFileError>;
  }
>()("@rpgtl/server/translation/RunReport") {}
