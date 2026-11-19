# OhMyStash

OhMyStash (OMS, `@hkay-dev/ohmystash`) is an Oh My Pi plugin that stores unfinished prompts without sending them. TypeScript on Bun, entry point `extensions/prompt-stash.ts`. Product and design notes are in `../PRODUCT.md` and `../DESIGN.md`.

## Checks

- `foundry app check ohmystash` (runs `scripts/check.sh` from any folder: `bun install --frozen-lockfile`, then `bun run check`, which is `tsc --noEmit` and the tests in `tests/`). `scripts/dev.sh` runs the same and prints how to load this checkout with `omp --plugin-dir`.
- The full `bun run test` (all of `tests/`) only when Harsha asks.
- The `capture:*` scripts and `benchmark:cross-chat` are for showcase media and benchmarks, not checks.
- In a test that waits for the stash folder watch, write the change again until the refresh arrives. macOS starts a watch a moment after `watch()` returns and drops changes made before that, so a test that waits on one write hung for 60s under load (ohmystash#4w2t).

## Install and release

- Install: `omp plugin install github:hkay-dev/OhMyStash`; the README has the details. Harsha's installed copy lives under `~/.omp/plugins/local-builds/`.
- Ship: Run `foundry ship run ohmystash`. Read "Quirks" in `docs/working-here.md` for the shared helper sequence. Foundry pushes `main` (`docs/releasing.md`).
- Follow `skill://omp-plugin` for packaging and release rules. When bumping the version, also update the `#vX.Y.Z` pins in `README.md`, `docs/ui.md`, `docs/guide/install.md` and `docs/guide/for-plugin-authors.md`.
- Release steps, the packed-file check and the installed-runtime proof are in `docs/releasing.md`.
- `docs/ui.md`, `docs/send-targets.md` and `docs/native-ui.md` describe the shared UI, send-target and native UI host exports.

Visibility: public
