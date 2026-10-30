#!/bin/sh
# Ship it (`deckhand ship run ohmystash`): installs HEAD into OMP on this Mac through Armada's shared
# ship-omp-plugin (pack, new local-builds folder, symlink and lock swap with rollback, plugin doctor,
# dotfiles source records, prune). The app's check already ran; this script never pushes or tags.
# The public GitHub release (tag, release notes) stays manual: docs/releasing.md.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
[ -z "$(git -C "$repo" status --porcelain --untracked-files=no)" ] || { echo "ship: uncommitted changes in $repo" >&2; exit 1; }
exec ship-omp-plugin "$repo"
