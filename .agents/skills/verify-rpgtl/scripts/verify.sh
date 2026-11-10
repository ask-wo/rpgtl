#!/usr/bin/env bash
# Launches a run, checks it with doctor.sh, drives one steps file and cleans up, in one command.
# Prints the evidence folder and exits with the steps' result. The run folder stays until
# `cleanup.sh --prefix <name>` deletes it.
# Usage: verify.sh <run name> <MV|MZ|real-MV> <steps.ts>
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
name=${1:?Usage: verify.sh <run name> <MV|MZ|real-MV> <steps.ts>}
engine=${2:?Usage: verify.sh <run name> <MV|MZ|real-MV> <steps.ts>}
steps=$(realpath "${3:?Usage: verify.sh <run name> <MV|MZ|real-MV> <steps.ts>}")

run=$("$here/launch.sh" "$name" "$engine") || exit 1
status=0
if "$here/doctor.sh" "$run" >"$run/evidence/doctor.log" 2>&1; then
  node "$here/drive.ts" "$run" "$steps" || status=$?
else
  cat "$run/evidence/doctor.log" >&2
  status=1
fi
"$here/cleanup.sh" "$run" >/dev/null || status=1
echo "Evidence: $run/evidence"
exit "$status"
