# Changelog

## Unreleased

### Changed

- Make the existing settings capture require a real packaged artifact and matching installed compiled OMP, with private HOME/XDG/agent roots instead of copied live configuration.
- Exercise stash/restore and browser shortcuts, retained synthetic storage and plugin settings without model inference. Keep source/fixture media separate from packaged consumer evidence.
- Install the packaged archive and exact matching SDK peers in the isolated consumer before registration; linking extracted bytes alone omits runtime dependencies.

## 1.9.0 - 2026-10-04

### Changed

- Export the shared square popup UI from `@hkay-dev/ohmystash/ui`: `createFrame`, `fitToWidth`, `extensionIcon`, `selectOption`, and `POPUP_OPTIONS`. Consumers must install the package dependency rather than copy a standalone extension file.
- Center custom overlays at 90% of terminal width, with accent-colored square borders and embedded titles.
- Use contextual Nerd Font glyphs in the stash browser, honoring Show icons without changing OMP's global symbol preset. Keep native `/settings` → Plugins chrome.
- Retain existing stash/restore, chat scope, search, queue actions, attachments, editing, locks, deletion, recovery, retention, storage protections, and adaptive browser layouts.

### Checks

- Compiled OMP 18.6.1 loaded the installed npm archive; stash/restore, the browser, and the native plugin settings page were exercised.
- All 35 unit tests passed. No model requests were made; backend integration was not tested.

## 1.8.7 - 2026-09-24

### Changed

- Verify compatibility with OMP 18.3.0 and update the OMP development dependencies and lockfile to 18.3.0. No source changes were needed. The minimum supported version stays at OMP 18.2.5.

### Checks

- OMP 18.3.0 loaded the installed extension and registered `/stash` with no load warnings.
- All 29 tests and the TypeScript check passed against OMP 18.3.0.

## 1.8.6 - 2026-09-17

### Fixed

- Fix extension loading on OMP 18.2.5 by importing `blobExtensionForImageMimeType` from `@oh-my-pi/pi-tui/prompt/image-format`. OMP moved the helper out of `@oh-my-pi/pi-coding-agent/session/blob-store`, causing OhMyStash to fail with a missing-export warning.

### Changed

- Require OMP 18.2.5 or newer and update the OMP development dependencies and lockfile to 18.2.5.

### Checks

- OMP 18.2.5 loaded the installed extension and registered `/stash`.
- All 29 tests and the TypeScript check passed.
