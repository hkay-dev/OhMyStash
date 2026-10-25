# OhMyStash

OhMyStash (OMS, `@hkay-dev/ohmystash`) is an Oh My Pi plugin that stores unfinished prompts without sending them. TypeScript on Bun, entry point `extensions/prompt-stash.ts`. Product and design notes are in `../PRODUCT.md` and `../DESIGN.md`.

## Checks

- `bun run check` (runs `tsc --noEmit`).
- For a change, `bun test <file>` on the matching file in `tests/`. The full `bun run test` (all of `tests/`) only when Harsha asks.
- The `capture:*` scripts and `benchmark:cross-chat` are for showcase media and benchmarks, not checks.

## Install and release

- Install: `omp plugin install github:hkay-dev/OhMyStash`; the README has the details. Harsha's installed copy lives under `~/.omp/plugins/local-builds/`.
- Ship: `tend ship ohmystash` (runs `repo/scripts/ship.sh`: clean tree, `bun run check`, a quick UI test, pack HEAD, new `local-builds` folder, symlink, lock, dotfiles commit). The script doesn't push the repo or tag; the public GitHub release stays manual (`docs/releasing.md`). Dotfiles needs a push after a ship.
- Release steps, the packed-file check and the installed-runtime proof are in `docs/releasing.md`.
- `docs/ui.md`, `docs/send-targets.md` and `docs/native-ui.md` describe the shared UI, send-target and native UI host exports.

## Docs and bugs

Docs: docs
Bugs: kata project ohmystash
Visibility: public
