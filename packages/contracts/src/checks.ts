import * as Schema from "effect/Schema";

/** Problems an accepted translation can have that a script can spot, for a person to look at. */
export const CheckName = Schema.Literals([
  "source text left",
  "speaker name repeated",
  "number added on a last line",
  "refusal",
  "length unlike the source",
  "glossary name missing",
  "pronoun unlike the source",
]);
export type CheckName = typeof CheckName.Type;

export const Finding = Schema.Struct({
  check: CheckName,
  /** What in the entry the check found, such as the glossary term. */
  detail: Schema.optionalKey(Schema.String),
});
export type Finding = typeof Finding.Type;

/** What the checks found in a catalog's translated entries, by entry id. */
export const Findings = Schema.Record(Schema.String, Schema.Array(Finding));
export type Findings = typeof Findings.Type;
