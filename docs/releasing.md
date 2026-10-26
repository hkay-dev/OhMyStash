# Releasing OhMyStash

These are maintainer notes. You don't need any of this to use the plugin.

## Install archive

The install archive has `package.json` and the runtime files in `extensions/`. Full documentation, demo media, tests, benchmarks, and capture tools stay in the repository.

The package `files` allowlist limits npm and Bun packs. GitHub downloads also use `.gitattributes` export rules, because Bun's Git dependency installer doesn't apply the `files` allowlist. `git archive` uses the same export rules when preparing a release package.

To check the file list, pack the committed revision without lifecycle scripts:

```sh
tmp="$(mktemp -d)"
git archive HEAD | tar -x -C "$tmp"
(cd "$tmp" && npm pack --ignore-scripts --dry-run)
```

`bun pm pack` adds the README, so use `npm pack` here.

## Packaged installed-runtime proof

Use the existing [settings capture](../showcase/ohmystash-settings.video.ts) to check a real package archive through the installed compiled OMP loader, not `-e` against this worktree. Review the installed version's contracts first. The recipe below targets stock OMP 18.10.4 using its tagged [CLI](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.10.4/docs/cli-reference.md), [loader](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.10.4/docs/extension-loading.md), [installer](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.10.4/docs/plugin-manager-installer-plumbing.md), and [root-path](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.10.4/docs/environment-variables.md) documentation. A newer source checkout isn't matching-version evidence.

From this repository, with the capture dependencies installed:

```sh
export OMS_CAPTURE_OUTPUT="$(mktemp -d "${TMPDIR:-/tmp}/ohmystash-proof.XXXXXX")"
mkdir "$OMS_CAPTURE_OUTPUT/source"
git archive HEAD | tar -x -C "$OMS_CAPTURE_OUTPUT/source"
artifact_name="$(npm pack "$OMS_CAPTURE_OUTPUT/source" --ignore-scripts --pack-destination "$OMS_CAPTURE_OUTPUT")"
export OMS_CAPTURE_ARTIFACT="$OMS_CAPTURE_OUTPUT/$artifact_name"
export OMS_CAPTURE_OMP="$(command -v omp)"
export OMS_CAPTURE_OMP_VERSION=18.10.4
npm exec -- tcut test showcase/ohmystash-settings.video.ts
npm run capture:settings
npm exec -- tcut doctor "$OMS_CAPTURE_OUTPUT/ohmystash-release.cast"
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height,avg_frame_rate -of json "$OMS_CAPTURE_OUTPUT/ohmystash-release.mp4"
```

`git archive` exports the committed revision's runtime files, then `npm pack` creates the install archive without lifecycle scripts. For an approved release artifact, set `OMS_CAPTURE_ARTIFACT` to that archive instead. Record the revision and SHA-256; a local pack isn't publication evidence. The helper requires the exact expected version and a compiled executable, with no source-launcher fallback.

Before OMP can import any extension, the helper clears inherited profile, credential, and session environment values and creates private HOME, agent, cwd, temporary, and XDG roots. It writes reviewed startup, background-disable, and display settings plus the catalog described below, never live config, models, auth, or stashes. It installs the archive and exact matching-version SDK peers into a disposable consumer with Bun lifecycle scripts disabled, records peer versions, registers the installed package with an isolated `omp plugin link`, and starts compiled OMP without `-e` or `--no-extensions`. Linking extracted bytes alone doesn't supply runtime dependencies such as `pi-tui`. Dependency installation may fetch public packages; no prompt is submitted.

Local commands still need a selected model. The fixture writes credential-free synthetic Flash catalog metadata with a reserved `.invalid` endpoint and selects only that entry. That allows local UI commands; it doesn't provide a backend or prove inference.

The captured sequence exercises Alt+S save and restore, Alt+Shift+S browser entry, Enter restore, one retained synthetic stash under the isolated agent root, and plugin settings visibility. Successful shutdown removes only that run's fixture. A failure leaves the private fixture for diagnosis. The JSON receipt says `prepared` until those consumer checks and exit status 0 succeed, then `consumer-exercised`; it doesn't claim media acceptance. Inspect both PNGs, the GIF or MP4, and the complete raw cast and header, including hidden intervals and environment values, before accepting release evidence.

This is one-session PTY shortcut, TUI, and storage evidence with the recorded dependency graph. It doesn't establish physical OS key delivery, queue dispatch or model inference, attachments, restart durability, registry publication, or upgrades. Background discovery may contact public metadata endpoints, and fresh roots aren't a network or OS sandbox.

The older browser showcase and `capture:all` use worktree and seeded fixtures, and their queue-submit scene can dispatch inference. They aren't this packaged-release check or an offline recipe, so don't use them as installed-release evidence.

## Release steps

1. `bun run check` and `bun test` pass.
2. Check the packed file list as above. It should list only `package.json` and `extensions/`.
3. Run the packaged installed-runtime proof against the installed OMP version.
4. Update `CHANGELOG.md`, the version in `package.json` and the pinned tag in the README's Install section (`github:hkay-dev/OhMyStash#vX.Y.Z`), commit, push to `main`, tag `vX.Y.Z`, and create the GitHub release from that tag.
