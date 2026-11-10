#!/usr/bin/env bash
# Starts an isolated RPGTL for verification and prints its run folder.
# Usage: launch.sh [run name] [MV|MZ|real-MV]
# The run folder (.verify/<name>/ in the repo) holds the server's state, settings, a link to the
# fixture game, the server log and evidence/. Set RPGTL_DEV=1 to rebuild packages/game/src/ on every request.
# Claude's sessions and Codex's login live under XDG_STATE_HOME, which is $run/state-home unless
# RPGTL_VERIFY_STATE_HOME names another folder, such as one holding a Codex login for a Codex run.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
name=${1:-$(date +%Y%m%d-%H%M%S)}
engine=${2:-MV}
[[ $name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "A run name is letters, digits, '.', '_' and '-', not '$name'." >&2; exit 1; }
run="$repo/.verify/$name"

if [[ -e "$run/server.pid" ]]; then
  echo "$run already has a server (pid $(cat "$run/server.pid")). Run cleanup.sh on it or pick another name." >&2
  exit 1
fi
state_home=${RPGTL_VERIFY_STATE_HOME:-$run/state-home}
mkdir -p "$run/state" "$run/config" "$run/evidence" "$state_home"
# The page shows the game's folder, and screenshots go into public pull requests, so the game
# lives at a path that names no user; $run/game links to it. Each run gets its own folder, as
# other checkouts of the repo may use the same run name.
game=$(mktemp -d /tmp/rpgtl-verify-XXXXXXXX)/game
node "$here/fixture.ts" "$game" "$engine" >/dev/null
ln -sfn "$game" "$run/game"

# The image reader the server asks: RPGTL_IMAGE_READER, or else a free port where a steps file's
# fake reader can listen (examples/image-text.ts reads it from $run/reader-url).
reader=${RPGTL_IMAGE_READER:-http://127.0.0.1:$(node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')}
echo "$reader" >"$run/reader-url"

# PORT=0 lets the OS pick a free port; the ready line names it. setsid gives the server its
# own process group, so cleanup.sh can stop it without touching anything else.
cd "$repo"
RPGTL_DIR="$run/state" XDG_CONFIG_HOME="$run/config" XDG_STATE_HOME="$state_home" PORT=0 RPGTL_IMAGE_READER="$reader" RPGTL_DEV="${RPGTL_DEV:-}" \
  setsid node apps/server/src/main.ts >"$run/server.log" 2>&1 &
echo $! >"$run/server.pid"
git rev-parse HEAD >"$run/commit"

for _ in $(seq 100); do
  if url=$(grep -oP 'RPGTL is ready: \K\S+' "$run/server.log"); then
    echo "${url%/}" >"$run/url"
    echo "$run"
    exit 0
  fi
  if ! kill -0 "$(cat "$run/server.pid")" 2>/dev/null; then
    echo "The server exited before it was ready:" >&2
    cat "$run/server.log" >&2
    exit 1
  fi
  sleep 0.1
done
echo "The server was not ready after 10 s; see $run/server.log" >&2
exit 1
