#!/bin/sh
# Prints oxlint's findings for the given paths, one line each: rule, file:line, message, then
# knip's unused files, exports and dependencies in the whole workspace, which no path narrows.
# Oxlint's text output changes with the terminal, so this reads --format json.
code=0
pnpm exec effect-tsgo --tsrs-lint vp lint --format json "$@" 2>/dev/null | node -e '
let text = "";
process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
  const { diagnostics = [] } = JSON.parse(text.slice(text.indexOf("{")));
  for (const d of diagnostics)
    console.log(`${d.code} ${d.filename}:${d.labels?.[0]?.span?.line ?? ""} ${d.message}`);
  process.exitCode = diagnostics.length ? 1 : 0;
});' || code=1
pnpm exec knip --reporter compact || code=1
exit $code
