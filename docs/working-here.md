---
type: guide
summary: How to check a change in OhMyStash, with its quirks and hot paths.
---

# Working here

## How to check

- **Check:** `bun run check` in `repo/` (runs `tsc --noEmit`). For a change, also `bun test <file>` on the matching file in `tests/`. The full `bun run test` runs only when Harsha asks.
- **Build wrapper:** none. Run `bun` directly. The `capture:*` scripts and `benchmark:cross-chat` make showcase media and benchmarks, not checks.
- **Quirks:** the public repo is `hkay-dev/OhMyStash`. Harsha's installed copy lives under `~/.omp/plugins/local-builds/`. Ship with `deckhand ship run ohmystash` (`repo/scripts/ship.sh` hands HEAD to Armada's shared `ship-omp-plugin`: pack, new `local-builds` folder, symlink and lock swap with rollback, plugin doctor, dotfiles source records, prune). It runs no checks (the app's check already ran), never pushes or tags, and writes the dotfiles records without committing them; the public GitHub release stays manual (`docs/releasing.md`).
- **Hot paths:** `extensions/prompt-stash.ts` is the entry point. The shared UI, send-target and native UI host exports other plugins import are in [ui.md](ui.md), [send-targets.md](send-targets.md) and [native-ui.md](native-ui.md).
- **Devices:** none. The packaged-release proof runs in an isolated compiled OMP (`docs/releasing.md`), never against live config or stashes.
