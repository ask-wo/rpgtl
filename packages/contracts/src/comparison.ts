import * as Schema from "effect/Schema";
import { Entry, GlossaryTerm } from "./catalog.ts";
import { RunLogLine } from "./runLog.ts";
import { TranslationSettings } from "./translation.ts";

export const SampleGroup = Schema.Struct({
  label: Schema.String,
  ids: Schema.Array(Schema.String),
});
export type SampleGroup = typeof SampleGroup.Type;

/**
 * The entries `pnpm run compare` translates, by entry id, saved as
 * `games/<game id>/samples.json` in the state folder so later comparisons use the same text.
 * Groups may be edited by hand to add lines a translator got wrong before.
 */
export const Samples = Schema.Struct({
  gameId: Schema.String,
  groups: Schema.Array(SampleGroup),
  /** English that entries keep instead of being translated, such as earlier lines of a scene. */
  fixed: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type Samples = typeof Samples.Type;

/** One translator setup a comparison runs, as the command line gives it. */
export const ComparisonSetup = Schema.Struct({
  /** The setup as typed, or its `@as=` label. */
  label: Schema.String,
  settings: TranslationSettings,
  /** Entries per request, instead of the translator's own batch size. */
  batchSize: Schema.optionalKey(Schema.Int),
});
export type ComparisonSetup = typeof ComparisonSetup.Type;

/** A setup's run on the sample. */
export const ComparedSetup = Schema.Struct({
  ...ComparisonSetup.fields,
  /** The lines a run's log would hold: requests, questions, warnings and the end line. */
  lines: Schema.Array(RunLogLine),
  /** Wall time of the run, model loading included. */
  ms: Schema.Finite,
  /** The most VRAM the run took beyond what was in use before it, in MiB, when nvidia-smi said. */
  vramMiB: Schema.optionalKey(Schema.Int),
});
export type ComparedSetup = typeof ComparedSetup.Type;

/** What `pnpm run compare` saves next to its HTML report. */
export const Comparison = Schema.Struct({
  game: Schema.Struct({ id: Schema.String, title: Schema.String }),
  samples: Samples,
  /**
   * The sample's entries, untranslated but for fixed ones, and the glossary with pronouns from
   * the whole game, before a setup's `@read` adds names.
   */
  sample: Schema.Struct({ entries: Schema.Array(Entry), glossary: Schema.Array(GlossaryTerm) }),
  setups: Schema.Array(ComparedSetup),
});
export type Comparison = typeof Comparison.Type;
