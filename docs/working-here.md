---
type: guide
summary: How to check a change in OhMyStash, with its quirks and hot paths.
---

# Working here

## How to check

- **Check:** `bun run check` in `repo/` (runs `tsc --noEmit`). For a change, also `bun test <file>` on the matching file in `tests/`. The full `bun run test` runs only when Harsha asks.
- **Build wrapper:** none. Run `bun` directly. The `capture:*` scripts and `benchmark:cross-chat` make showcase media and benchmarks, not checks.
- **Quirks:** the public repo is `hkay-dev/OhMyStash`. Harsha's installed copy lives under `~/.omp/plugins/local-builds/`. Ship with `tend ship ohmystash` (`repo/scripts/ship.sh`: clean tree, `bun run check`, a quick UI test, pack HEAD, new `local-builds` folder, symlink, lock, dotfiles commit). It doesn't push the repo or tag; the public GitHub release stays manual (`docs/releasing.md`), and dotfiles needs a push after a ship.
- **Hot paths:** `extensions/prompt-stash.ts` is the entry point. The shared UI and send-target exports other plugins import are in [ui.md](ui.md) and [send-targets.md](send-targets.md).
- **Devices:** none. The packaged-release proof runs in an isolated compiled OMP (`docs/releasing.md`), never against live config or stashes.
