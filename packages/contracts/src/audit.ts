import * as Schema from "effect/Schema";
import { CheckName } from "./checks.ts";
import { RejectReason, RunEndLine, RunStartLine } from "./runLog.ts";

/** What a run's log says about the run as a whole. */
export const RunSummary = Schema.Struct({
  file: Schema.String,
  start: Schema.optionalKey(RunStartLine),
  end: Schema.optionalKey(RunEndLine),
  warnings: Schema.Array(Schema.String),
  requests: Schema.Int,
  /** Questions about term kinds and pronouns, and how many of them failed. */
  asks: Schema.Int,
  failedAsks: Schema.Int,
  /** Entries the run's answers translated. */
  answers: Schema.Int,
});
export type RunSummary = typeof RunSummary.Type;

/** A run's guess that the user replaced with a value of their own. */
export const Correction = Schema.Struct({
  /** An entry's English, or a glossary term's English, kind or pronoun. */
  of: Schema.Literals(["translation", "termTranslation", "kind", "pronoun"]),
  /** The entry's id, or the term's source. */
  id: Schema.String,
  source: Schema.String,
  guess: Schema.String,
  user: Schema.String,
});

export const FindingGroup = Schema.Struct({
  check: CheckName,
  count: Schema.Int,
  /** Up to 20. */
  examples: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      source: Schema.String,
      translation: Schema.String,
      detail: Schema.optionalKey(Schema.String),
    }),
  ),
});

export const RejectionGroup = Schema.Struct({
  reason: RejectReason,
  count: Schema.Int,
  /** Up to 10 different sources. */
  sources: Schema.Array(Schema.String),
});
export type RejectionGroup = typeof RejectionGroup.Type;

/** Counts from one run's own answers, so runs compare whatever happened to the catalog since. */
export const RunTotals = Schema.Struct({
  file: Schema.String,
  start: Schema.optionalKey(RunStartLine),
  answers: Schema.Int,
  /** Entries the run gave up on; none when the log has no end line. */
  failed: Schema.optionalKey(Schema.Int),
  /** Rejections by reason, leaving out reasons no answer had. */
  rejected: Schema.Record(Schema.String, Schema.Int),
  /** Answers each check flags, by check, leaving out checks that flagged none. */
  findings: Schema.Record(Schema.String, Schema.Int),
});
export type RunTotals = typeof RunTotals.Type;

/** What `pnpm run audit` finds in a game's catalog and one of its run logs. */
export const AuditReport = Schema.Struct({
  /**
   * Ordinary-word glossary terms whose English appears capitalised mid-sentence in prose, most
   * lines first; a name sorted as a word shows up here too.
   */
  capitalised: Schema.Array(
    Schema.Struct({
      source: Schema.String,
      english: Schema.String,
      lines: Schema.Int,
      of: Schema.Int,
    }),
  ),
  /** Sources, with their speaker, that got different translations. */
  differing: Schema.Struct({
    count: Schema.Int,
    examples: Schema.Array(
      Schema.Struct({
        source: Schema.String,
        speaker: Schema.optionalKey(Schema.String),
        translations: Schema.Array(Schema.String),
      }),
    ),
  }),
  /** Accepted translations each check flags, in the order of `CheckName`. */
  findings: Schema.Array(FindingGroup),
  /** The run, the user's corrections of its guesses and the rejections; none without a run log. */
  run: Schema.optionalKey(
    Schema.Struct({
      summary: RunSummary,
      /** How many values the run guessed that the catalog keeps, and those the user corrected. */
      corrections: Schema.Struct({
        of: Schema.Int,
        count: Schema.Int,
        examples: Schema.Array(Correction),
      }),
      rejections: Schema.Struct({
        /** Every rejection in the log. */
        all: Schema.Array(RejectionGroup),
        /** Entries still untranslated, by the reason of their last rejection. */
        untranslated: Schema.Array(RejectionGroup),
      }),
    }),
  ),
  /** The run before's totals next to this run's, with `--compare`. */
  comparison: Schema.optionalKey(Schema.Struct({ before: RunTotals, after: RunTotals })),
});
export type AuditReport = typeof AuditReport.Type;

/** Text in the game's data or plugin settings that no entry covers, by where it is. */
export const MissingText = Schema.Struct({
  /** A data file (maps as `Map*.json`) and the field or event command parameter. */
  where: Schema.String,
  /** False when the field holds only file names or names the editor shows, never the player. */
  shown: Schema.Boolean,
  count: Schema.Int,
  /** Up to 5 different texts. */
  examples: Schema.Array(Schema.String),
});
export type MissingText = typeof MissingText.Type;

/** Translated text that game logic also uses as a value. */
export const LogicUse = Schema.Struct({
  where: Schema.String,
  text: Schema.String,
  translation: Schema.String,
  /** The script, note or command line that uses the text. */
  line: Schema.String,
});
export type LogicUse = typeof LogicUse.Type;
