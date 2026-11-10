import type { AuditReport, LogicUse, MissingText } from "@rpgtl/contracts";
import {
  audit,
  type GameFileInvalid,
  gameLanguage,
  runTotals,
  missingText,
  textInLogic,
} from "@rpgtl/domain";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Catalogs from "../games/Catalogs.ts";
import * as GameFolder from "../games/GameFolder.ts";
import * as Games from "../games/Games.ts";
import type * as StateFolder from "../state/StateFolder.ts";
import * as RunLogs from "../translation/RunLogs.ts";

/** A run log the audit was asked for that the game doesn't have. */
export class NoRunLogError extends Schema.TaggedError<NoRunLogError>()("NoRunLogError", {
  id: Schema.String,
  /** The run before the newest, or the run before the audited one. */
  missing: Schema.Literals(["previous", "before"]),
}) {
  override get message() {
    switch (this.missing) {
      case "previous":
        return `No earlier run log for game ${this.id}.`;
      case "before":
        return `No run before this one to compare with for game ${this.id}.`;
    }
  }
}

/** Which run log an audit reads. */
export type LogChoice =
  | { readonly _tag: "Newest" }
  | { readonly _tag: "Previous" }
  | { readonly _tag: "File"; readonly file: string };

type CatalogError = Games.GameNotInspectedError | StateFolder.StateFileError;

/** What to look at in a game's translations and its runs (`pnpm run audit`). */
export class Audit extends Context.Service<
  Audit,
  {
    /**
     * Audits the game's catalog and the chosen run log, when the game has one; with `compare`,
     * adds the counts of the run before it.
     */
    readonly report: (
      id: string,
      options: { readonly log: LogChoice; readonly compare: boolean },
    ) => Effect.Effect<AuditReport, CatalogError | RunLogs.RunLogReadError | NoRunLogError>;
    /** Text in the game's data and plugin settings that no entry covers. */
    readonly coverage: (
      id: string,
    ) => Effect.Effect<
      ReadonlyArray<MissingText>,
      CatalogError | GameFolder.GameFileReadError | GameFileInvalid
    >;
    /** Translated text that scripts, conditions, notes, plugin commands or plugin code use. */
    readonly logic: (
      id: string,
    ) => Effect.Effect<
      ReadonlyArray<LogicUse>,
      CatalogError | GameFolder.GameFileReadError | GameFileInvalid
    >;
  }
>()("@rpgtl/server/audit/Audit") {}

const make = Effect.gen(function* () {
  const games = yield* Games.Games;
  const catalogs = yield* Catalogs.Catalogs;
  const folder = yield* GameFolder.GameFolder;
  const logs = yield* RunLogs.RunLogs;
  const path = yield* Path.Path;

  /** The chosen log's file, and the file of the run before it, of the game's logs. */
  const files = Effect.fnUntraced(function* (id: string, log: LogChoice) {
    const listed = yield* logs.list(id);
    const given = log._tag === "File" ? Option.some(path.resolve(log.file)) : Option.none();
    const index = Option.match(given, {
      onSome: (file) => listed.indexOf(file),
      onNone: () => (log._tag === "Previous" ? 1 : 0),
    });
    const file = Option.orElse(given, () => Option.fromUndefinedOr(listed[index]));
    if (log._tag === "Previous" && Option.isNone(file))
      return yield* new NoRunLogError({ id, missing: "previous" });
    return { file, before: Option.fromUndefinedOr(index < 0 ? undefined : listed[index + 1]) };
  });

  const report = Effect.fn("Audit.report")(function* (
    id: string,
    options: { readonly log: LogChoice; readonly compare: boolean },
  ) {
    const catalog = yield* catalogs.get(id);
    const { file, before } = yield* files(id, options.log);
    const log = yield* Effect.transposeOption(Option.map(file, logs.read));
    const result = audit(catalog, Option.getOrUndefined(log));
    if (!options.compare) return result;
    const language = gameLanguage(catalog);
    if (Option.isNone(log) || Option.isNone(before))
      return yield* new NoRunLogError({ id, missing: "before" });
    return {
      ...result,
      comparison: {
        before: runTotals(yield* logs.read(before.value), catalog.glossary, language),
        after: runTotals(log.value, catalog.glossary, language),
      },
    } satisfies AuditReport;
  });

  const coverage = Effect.fn("Audit.coverage")(function* (id: string) {
    const game = yield* games.get(id);
    const catalog = yield* catalogs.get(id);
    return missingText(yield* folder.contents(game), game.files, catalog);
  });

  const logic = Effect.fn("Audit.logic")(function* (id: string) {
    const game = yield* games.get(id);
    const catalog = yield* catalogs.get(id);
    return textInLogic(yield* folder.contents(game), catalog);
  });

  return Audit.of({ report, coverage, logic });
});

export const layer = Layer.effect(Audit, make);
