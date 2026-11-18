# OhMyStash

OhMyStash (OMS, `@hkay-dev/ohmystash`) is an Oh My Pi plugin that stores unfinished prompts without sending them. TypeScript on Bun, entry point `extensions/prompt-stash.ts`. Product and design notes are in `../PRODUCT.md` and `../DESIGN.md`.

## Checks

- `deckhand app check ohmystash` (runs `scripts/check.sh` from any folder: `bun install --frozen-lockfile`, then `bun run check`, which is `tsc --noEmit` and the tests in `tests/`). `scripts/dev.sh` runs the same and prints how to load this checkout with `omp --plugin-dir`.
- The full `bun run test` (all of `tests/`) only when Harsha asks.
- The `capture:*` scripts and `benchmark:cross-chat` are for showcase media and benchmarks, not checks.
- In a test that waits for the stash folder watch, write the change again until the refresh arrives. macOS starts a watch a moment after `watch()` returns and drops changes made before that, so a test that waits on one write hung for 60s under load (ohmystash#4w2t).

## Install and release

- Install: `omp plugin install github:hkay-dev/OhMyStash`; the README has the details. Harsha's installed copy lives under `~/.omp/plugins/local-builds/`.
- Ship: Run deckhand ship run ohmystash. Read "Quirks" in docs/working-here.md for the shared helper sequence. Deckhand pushes main (docs/releasing.md).
- Before you land a commit that will ship, check whether `v<version>` from `package.json` already tags an older commit (`git rev-list -n1 v<version>`). If it does, bump the patch version and the `#vX.Y.Z` pins in README.md, `docs/ui.md`, `docs/guide/install.md` and `docs/guide/for-plugin-authors.md` in the same change: the ship helper refused an already tagged version (ohmystash#s3gv).
- Release steps, the packed-file check and the installed-runtime proof are in `docs/releasing.md`.
- `docs/ui.md`, `docs/send-targets.md` and `docs/native-ui.md` describe the shared UI, send-target and native UI host exports.

Visibility: public
