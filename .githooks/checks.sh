#!/bin/sh
# Formats, then runs `pnpm run check` and `vp test`, unless the same files already passed both.
# Both run at the same time, and both run even when the other fails; the static checks' log is next to the tests' as `<output>.static`.
# With --no-format (the pre-push hook) it leaves files as they are and only checks the format.
# Markdown is left out of the comparison, since no check reads it. A run that skipped tests for
# lack of a desktop session doesn't count as passed, so the full suite still runs outside a sandbox.
set -e

# Shared by this checkout and its worktrees, so a tree that passed in one is skipped in the others.
passed="$(git rev-parse --path-format=absolute --git-common-dir)/rpgtl-checks-passed"
index="$(git rev-parse --git-path rpgtl-checks-index)"
output="${RPGTL_CHECKS_OUTPUT:-$(git rev-parse --git-path rpgtl-checks-output)}"

# The tree object the working tree would have, without ignored files and Markdown.
fingerprint() {
  rm -f "$index"
  GIT_INDEX_FILE="$index" git add -A -- . ':!*.md'
  GIT_INDEX_FILE="$index" git write-tree
}

[ "${1:-}" = --no-format ] || pnpm run format >/dev/null
before="$(fingerprint)"
if grep -qxF "$before" "$passed" 2>/dev/null; then
  echo "Checks and tests already passed for these files."
  exit 0
fi

# Prints the end of a failed step's log, or all of it in CI, so a failure doesn't flood an agent's context.
show() {
  if [ -n "${CI:-}" ]; then
    cat "$1"
  else
    grep -E '^ FAIL |^FAILED: ' "$1" | sort -u
    tail -n 40 "$1"
    echo "Full output: $1"
  fi
}

pnpm run check >"$output.static" 2>&1 &
checking=$!
code=0
pnpm exec vp test >"$output" 2>&1 || code=$?
static=0
wait "$checking" || static=$?
[ "$static" = 0 ] || show "$output.static"
if [ "$static" != 0 ] && [ "${1:-}" = --no-format ] && grep -q '^Format issues found' "$output.static"; then
  echo "The commit isn't formatted: run \`pnpm run checks\`, which formats, and amend the commit."
fi
if [ "$code" = 0 ]; then grep -E 'Test Files|Tests |Skipping tests' "$output"; else show "$output"; fi
# The last line says what failed, since a caller often reads only the end of the output.
if [ "$static" != 0 ] || [ "$code" != 0 ]; then
  echo "FAILED:$([ "$static" = 0 ] || echo " static checks")$([ "$code" = 0 ] || echo " tests")"
  exit 1
fi

if grep -q 'Skipping tests that need' "$output"; then
  echo "Tests were skipped for lack of a desktop session, so this run isn't recorded as passed."
elif [ "$(fingerprint)" = "$before" ]; then
  # The last 20 trees that passed, so checking each commit of a branch again skips the unchanged ones.
  { echo "$before"; head -n 19 "$passed" 2>/dev/null || true; } >"$passed.new"
  mv "$passed.new" "$passed"
fi
