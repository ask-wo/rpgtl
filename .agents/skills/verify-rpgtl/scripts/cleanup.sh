#!/usr/bin/env bash
# Stops what launch.sh and drive.ts started for one run and removes its scratch state.
# Keeps <run>/evidence/, with the server log moved into it.
# With --prefix <name>, does this for every .verify/<name>* run and then deletes those run folders, evidence included.
# Usage: cleanup.sh <run folder>
#        cleanup.sh --prefix <name>
set -uo pipefail

if [[ ${1:-} == --prefix ]]; then
  prefix=${2:?Usage: cleanup.sh --prefix <name>}
  [[ $prefix != */* ]] || { echo "--prefix takes a run name, not a path" >&2; exit 1; }
  verify=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)/.verify
  status=0
  for run in "$verify/$prefix"*/; do
    [[ -d $run ]] || continue
    run=${run%/}
    "${BASH_SOURCE[0]}" "$run" || status=1
    # Only runs that stopped cleanly are deleted.
    if [[ -f $run/server.pid || -f $run/browser.pid ]]; then
      echo "kept $run: a process is still running" >&2
      status=1
    else
      rm -rf -- "$run"
      echo "removed $run"
    fi
  done
  exit $status
fi

run=${1:?Usage: cleanup.sh <run folder> | --prefix <name>}
[[ -d $run && $(basename "$(dirname "$run")") == .verify ]] || { echo "$run is not a .verify/<name> run folder" >&2; exit 1; }

stop() {
  local file=$1 match=$2 pid
  pid=$(cat "$file" 2>/dev/null) || return 0
  if kill -0 "$pid" 2>/dev/null && tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q -- "$match"; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
    for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null
    echo "stopped $match (pid $pid)"
  fi
  rm -f "$file"
}
stop "$run/browser.pid" "$run/browser"
stop "$run/server.pid" "apps/server/src/main.ts"

mkdir -p "$run/evidence"
[[ -f $run/server.log ]] && mv "$run/server.log" "$run/evidence/server.log"
if [[ -L $run/game ]]; then
  game=$(readlink "$run/game")
  [[ $game =~ ^/tmp/rpgtl-verify-[A-Za-z0-9]{8}/game$ ]] && rm -rf "${game%/game}"
fi
rm -rf "$run/state" "$run/state-home" "$run/config" "$run/game" "$run/browser" "$run/url"
echo "evidence kept in $run/evidence"
