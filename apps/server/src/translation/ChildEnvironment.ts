import * as Context from "effect/Context";

/**
 * The environment the Claude and Codex CLIs start from, before each drops the variables that would
 * make it use an API key instead of the user's subscription. Tests set their own.
 */
export const ChildEnvironment = Context.Reference<Readonly<Record<string, string | undefined>>>(
  "@rpgtl/server/translation/ChildEnvironment",
  // Config reads one variable by name, but the CLIs need every variable but a few.
  // oxlint-disable-next-line no-restricted-properties -- see above
  { defaultValue: () => process.env },
);
