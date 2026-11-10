#!/bin/sh
# Runs the image reader as it is at a git ref, for `compare.py --erase --baseline`: reader_at.sh <ref> <port>.
# The sources are unpacked once per commit into RPGTL's cache folder; the installed reader's Python and models run
# them. IMAGE_TEXT_DEVICE (default gpu), IMAGE_TEXT_MODELS and READER_PYTHON override those.
set -eu
ref=$1
port=$2
root=$(git rev-parse --show-toplevel)
commit=$(git -C "$root" rev-parse --short "$ref^{commit}")
cache="${XDG_CACHE_HOME:-$HOME/.cache}/rpgtl"
dir="$cache/reader-at/$commit"
if [ ! -f "$dir/server.py" ]; then
  mkdir -p "$dir"
  git -C "$root" archive "$commit" apps/image-reader | tar -x -C "$dir" --strip-components=2
fi
cd "$dir"
exec env IMAGE_TEXT_DEVICE="${IMAGE_TEXT_DEVICE:-gpu}" IMAGE_TEXT_MODELS="${IMAGE_TEXT_MODELS:-$cache/image-reader/models}" \
  "${READER_PYTHON:-$cache/image-reader/venv/bin/python}" -m uvicorn server:app --port "$port"
