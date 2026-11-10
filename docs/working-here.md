---
type: guide
summary: How to check a change in OhMyStash, with its quirks and hot paths.
---

# Working here

## How to check

- **Check:** `deckhand app check ohmystash` (runs `scripts/check.sh`: `bun install --frozen-lockfile`, then `bun run check`: `tsc --noEmit` and the tests in `tests/`).
- **Build wrapper:** `qm with build ohmystash -- ./repo/scripts/check.sh` from `~/Development/core/ohmystash`; the app's check line runs `scripts/check.sh` under `qm with build ohmystash`. `scripts/dev.sh` runs the check and prints the `omp --plugin-dir` line for trying this checkout; it never starts OMP. The `capture:*` scripts and `benchmark:cross-chat` make showcase media and benchmarks, not checks.
- **Quirks:** the public repo is `hkay-dev/OhMyStash`. Harsha's installed copy lives under `~/.omp/plugins/local-builds/`. Ship with `deckhand ship run ohmystash` (`scripts/ship.sh` hands HEAD to Armada's shared `ship-omp-plugin`: pack, new `local-builds` folder, symlink and lock swap with rollback, plugin doctor, dotfiles source records, prune). The helper runs no checks and pushes no commits. It commits its two dotfiles source records unless either already has staged changes. For HEAD that the remote already contains, it creates and pushes the missing version tag and creates the missing GitHub release; it reports incomplete publication as a warning. See `docs/releasing.md`.
- **Hot paths:** `extensions/prompt-stash.ts` is the entry point. The shared UI, send-target and native UI host exports other plugins import are in [ui.md](ui.md), [send-targets.md](send-targets.md) and [native-ui.md](native-ui.md).
- **Devices:** none. The packaged-release proof runs in an isolated compiled OMP (`docs/releasing.md`), never against live config or stashes.
