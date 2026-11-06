#!/usr/bin/env bash
# The quick check for OhMyStash: installs what package.json pins, then `bun run check` (Armada's omp-plugin-check:
# tsc --noEmit, then bun test). Exit 0 means it passed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
bun install --frozen-lockfile
bun run check
