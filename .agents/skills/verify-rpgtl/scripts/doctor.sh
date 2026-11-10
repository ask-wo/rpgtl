#!/usr/bin/env bash
# Read-only check that a verification run's RPGTL is worth driving.
# Usage: doctor.sh <run folder>
set -uo pipefail
run=${1:?Usage: doctor.sh <run folder>}
fail=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }

pid=$(cat "$run/server.pid" 2>/dev/null) || { echo "FAIL no server.pid in $run (launch.sh not run, or cleaned up)"; exit 1; }
url=$(cat "$run/url" 2>/dev/null) || { echo "FAIL no url in $run"; exit 1; }
port=${url##*:}

if kill -0 "$pid" 2>/dev/null && tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q 'apps/server/src/main.ts'; then
  ok "server pid $pid is running apps/server/src/main.ts"
else
  bad "server pid $pid is gone; see $run/server.log"
fi

if ss -ltnpH "sport = :$port" 2>/dev/null | grep -q "pid=$pid,"; then
  ok "port $port belongs to pid $pid"
else
  bad "port $port is not held by pid $pid"
fi

environ=$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null)
if grep -qx "RPGTL_DIR=$run/state" <<<"$environ" && grep -qx "XDG_CONFIG_HOME=$run/config" <<<"$environ"; then
  ok "state and settings are isolated in $run"
else
  bad "the server does not use $run/state and $run/config; it may write the real RPGTL data"
fi
state_home=$(grep -oP '^XDG_STATE_HOME=\K.*' <<<"$environ" || true)
if [[ -n "$state_home" && "$state_home" != "$HOME/.local/state" ]]; then
  ok "Claude sessions and the Codex login live in $state_home"
else
  bad "the server has no XDG_STATE_HOME of its own; it may write ~/.local/state/rpgtl"
fi

token=$(curl -sf "$url/" | grep -oP 'name="rpgtl-token" content="\K[0-9a-f]+')
if [[ -n $token ]]; then
  ok "page serves a session token"
  if curl -sf -H "X-RPGTL-Token: $token" "$url/api/games" >/dev/null; then
    ok "API answers with the token: $(curl -s -H "X-RPGTL-Token: $token" "$url/api/games" | grep -o '"id"' | wc -l) game(s) open"
  else
    bad "API refused the token"
  fi
else
  bad "no page or token at $url"
fi

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
if [[ $(git -C "$repo" rev-parse HEAD) == "$(cat "$run/commit")" ]]; then
  ok "HEAD is still the commit the server started on"
else
  bad "HEAD moved since launch; restart the run to test the current code"
fi
newer=$(find "$repo/packages/game/src" "$repo/apps/server/src" -newer "$run/server.pid" -name '*.ts' | head -3)
[[ -z $newer ]] && ok "no packages/game/src/ or apps/server/src/ file changed since launch" || bad "server code changed since launch (restart): $newer"
exit $fail
