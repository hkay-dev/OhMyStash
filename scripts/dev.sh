#!/usr/bin/env bash
# Dev run of OhMyStash: installs, runs the check and prints how to load this checkout as a plugin. It never starts OMP
# itself (its TUI would hang an agent's shell), so the installed copy is untouched.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
bun install
bun run check
echo "dev: the check passed. To try this checkout, run in a terminal: omp --plugin-dir $PWD"
