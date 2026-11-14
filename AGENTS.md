# OhMyStash

OhMyStash (OMS, `@hkay-dev/ohmystash`) is an Oh My Pi plugin that stores unfinished prompts without sending them. TypeScript on Bun, entry point `extensions/prompt-stash.ts`. Product and design notes are in `../PRODUCT.md` and `../DESIGN.md`.

## Checks

- `deckhand app check ohmystash` (runs `scripts/check.sh` from any folder: `bun install --frozen-lockfile`, then `bun run check`, which is `tsc --noEmit` and the tests in `tests/`). `scripts/dev.sh` runs the same and prints how to load this checkout with `omp --plugin-dir`.
- The full `bun run test` (all of `tests/`) only when Harsha asks.
- The `capture:*` scripts and `benchmark:cross-chat` are for showcase media and benchmarks, not checks.

## Install and release

- Install: `omp plugin install github:hkay-dev/OhMyStash`; the README has the details. Harsha's installed copy lives under `~/.omp/plugins/local-builds/`.
- Ship: Run deckhand ship run ohmystash. Read "Quirks" in docs/working-here.md for the shared helper sequence. Deckhand pushes main (docs/releasing.md).
- Release steps, the packed-file check and the installed-runtime proof are in `docs/releasing.md`.
- `docs/ui.md`, `docs/send-targets.md` and `docs/native-ui.md` describe the shared UI, send-target and native UI host exports.

<!-- foundry:shared start -->
## Docs and bugs

Docs: docs
Bugs: foundry project ohmystash
Visibility: public

Shared Foundry rules, written by `foundry app sync-agents` from apps.yml (change apps.yml, not this block):

- Check: `./repo/scripts/check.sh` from `~/Development/core/ohmystash` (`foundry app check ohmystash` runs it).
- Before starting or stopping a local dev server, read `~/.agents/PORTHOLE.md` and `~/.agents/WHATTHEPORT.md`. Use `devup <name> --desc "..." -- <command>`.
- If this project sends Harsha any notification (a job, hook, daemon or app), send it through `notify` or `flare-send`, never Telegram directly. Follow `flare-send guide standard` for the title and description, use a template where the data has structure, and register the sender once: `flare-send apps set <source> --name <Name> --owner <path> [--template T]`.

App facts:

- Device: M5 Max MacBook Pro.
- Arch: arm64 only: Apple silicon (M5 Max), no Intel.
- No accessibility or other languages work: Harsha never wants it.
- An OMP plugin, public repo hkay-dev/OhMyStash.
<!-- foundry:shared end -->
