#!/bin/sh
# Typechecks, checks the format, lints and looks for unused code (lint-list.sh does both). Each step runs even when an
# earlier one fails, so one run lists every finding; it fails when any step did.
failed=""
# Lint goes last, one finding per line, so the end of the log that checks.sh shows lists them.
for step in "pnpm exec vp run typecheck" "pnpm exec vp fmt --check" "sh scripts/lint-list.sh"; do
  # shellcheck disable=SC2086 # a step is a command with its arguments
  $step || failed="$failed
FAILED: $step"
done
[ -z "$failed" ] || { echo "$failed"; exit 1; }
