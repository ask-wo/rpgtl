#!/bin/sh
# The e2e tests against the Linux download instead of the checkout: a change that only breaks the
# bundled server, the prebuilt page or the launcher fails here, not after a release.
set -e
pnpm run -s build-archive --target linux-x64
version=$(node -p 'require("./package.json").version')
unpacked=$(mktemp -d)
trap 'rm -rf "$unpacked"' EXIT
tar -xzf "dist/rpgtl-$version-linux-x64.tar.gz" -C "$unpacked"
RPGTL_E2E_ARCHIVE="$unpacked/rpgtl" pnpm run -s e2e "$@"
