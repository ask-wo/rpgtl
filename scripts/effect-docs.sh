#!/bin/sh
# Prints an index of the Effect docs, from the version reference-repos.toml pins: each LLMS.md
# section with its line and the example files it links. Read the sections and examples for the
# APIs you use; the `effect` skill already holds the conventions every change needs.
set -e
repos="$HOME/.agents/skills/reference-repos/repos.py"
effect="$("$repos" path effect)"
printf 'Effect docs: %s/LLMS.md\nExamples are relative to %s\n' "$effect" "$effect"
awk '
  /^```/ { code = !code; next }
  code { next }
  /^##+ / { printf "\n%s (line %d)\n", $0, NR; next }
  /^- \*\*\[/ { match($0, /\[[^]]*\]\([^)]*\)/); link = substr($0, RSTART + 1, RLENGTH - 2); sub(/\]\(\.\//, ": ", link); print "  - " link }
' "$effect/LLMS.md"
