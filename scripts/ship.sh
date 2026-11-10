#!/bin/sh
# Ship it (`deckhand ship run ohmystash`): installs HEAD into OMP on this Mac through Armada's shared
# ship-omp-plugin (pack, new local-builds folder, symlink and lock swap with rollback, plugin doctor,
# dotfiles source records, prune, tag and release). The app's check already ran. It pushes no commits;
# when the remote has HEAD, it tags HEAD v<version>, pushes that tag and creates the GitHub release.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
[ -z "$(git -C "$repo" status --porcelain --untracked-files=no)" ] || { echo "ship: uncommitted changes in $repo" >&2; exit 1; }
exec ship-omp-plugin "$repo"
