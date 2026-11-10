#!/bin/sh
# Runs checks.sh on the files of the commit given, without the checkout's other changes. It checks
# them in a worktree kept at .git/rpgtl-checked, so its packages stay installed between runs.
set -e
tree="$(git rev-parse "$1^{tree}")"
commit="$(git rev-parse --short "$1")"
# A hook gets its own GIT_DIR, which would point the commands below at this checkout instead of the
# worktree.
unset GIT_INDEX_FILE GIT_DIR
common="$(git rev-parse --path-format=absolute --git-common-dir)"
dir="$common/rpgtl-checked"
output="$(git rev-parse --path-format=absolute --git-path rpgtl-checks-output)"

exec 9>"$common/rpgtl-checked.lock"
flock 9
git worktree prune
[ -d "$dir" ] || git worktree add -q --detach "$dir" HEAD
cd "$dir"
git read-tree -u --reset "$tree"
git clean -fdq
pnpm install --prefer-offline --frozen-lockfile >"$output" 2>&1 || {
  tail -n 20 "$output"
  exit 1
}
echo "Checking $commit in $dir."
RPGTL_CHECKS_OUTPUT="$output" .githooks/checks.sh --no-format
