#!/usr/bin/env bash
# The quick check for OhMyStash: installs what package.json pins, then `bun run check` (Armada's omp-plugin-check:
# tsc --noEmit, then bun test). Exit 0 means it passed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if ! [[ -x node_modules/.bin/tsc && node_modules/.installed -nt bun.lock && node_modules/.installed -nt package.json ]]; then
    bun install --frozen-lockfile
    touch node_modules/.installed
fi
# The package loads one bundled file instead of 6 modules (ohmystash#mefc); fail when it lags the sources.
bun run bundle
if [ -n "$(git status --porcelain -- extensions/prompt-stash.bundle.js)" ]; then
    echo "check: extensions/prompt-stash.bundle.js is not the committed build of extensions/: commit the result of 'bun run bundle'" >&2
    exit 1
fi
bun run check
