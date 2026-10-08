# Changelog

## 1.10.3 - 2026-10-07

### Changed

- Open the browser and option pickers in OMP's stock bottom overlay, the one Switch Model uses. It spans the full width with no dimming and leaves the composer's draft, caret, and undo history untouched.
- Export `OVERLAY_OPTIONS` (`{ overlay: true }`) from `@hkay-dev/ohmystash/ui`, replacing the `POPUP_OPTIONS` export removed in 1.10.1. Custom pickers open with `ctx.ui.custom(factory, OVERLAY_OPTIONS)`.

### Fixed

- Fit the browser and pickers, with their titles and search rows, in short or narrow terminals.
- Keep a stash's final newline as it was when an external editor saves it unchanged. Editors that always add one, such as vim, nano, and helix, no longer turn a quit without changes into an edit.
- Ignore images whose chips you deleted from the composer. They no longer count as a draft or get stashed.
- Submit a queued stash with `Shift+Q` even when Enter is bound to insert a newline.
- Ignore a second browser shortcut press that arrives before the first browser opens.
- Stop using the old composer after another extension replaces it.
- Keep pastes and images added before OhMyStash attaches to the composer.
- Keep search typing fast in very long stashes.
- Deleting a stash no longer loses another session's edit or lock, and a leftover recovery file no longer brings a deleted stash back. Delete all skips a stash that another session is changing and still reports what it deleted.
- Never claim a save that another session is still writing. An edit cut off by a crash becomes exactly one conflict copy, and a damaged leftover file is set aside so it no longer blocks deleting its stash.
- Keep an edit that would go over the storage quota as a new stash, with a warning, instead of losing it. Locking and unlocking never hit the quota.
- Stop warning that entries were omitted while another session is still saving.
- Copy OMP's small image-format helper instead of importing a module that compiled OMP does not serve to extensions.

### Development

- Tests no longer read your global OMP plugin settings.
- Pin the TypeScript and Bun type versions, and type-check the benchmarks and capture scripts.

## 1.10.2 - 2026-10-07

### Fixed

- Limit the install archive to the extension runtime and package metadata. Leave demo media, tests, benchmarks, capture tools, and full documentation on GitHub.

## 1.10.1 - 2026-10-07

### Fixed

- Restore the normal `omp plugin install github:hkay-dev/OhMyStash` path on stock OMP 18.8.3. Standard SDK dependencies install automatically, with no custom executable, SDK archives, or overrides.
- Replace renderer-specific popups with bottom-docked inline pickers, like OMP's built-in Switch Model dialog. Keep square accent frames and restore the composer and attachments on close.
- Remove custom backdrop settings and the overlay-options export from the shared UI. Conversation history keeps its colors without dimming, desaturation, or a full-screen blackout.
- Keep stash/restore, browser search and chat scope, queue actions, attachments, editing, locks, recovery, retention, and native plugin settings.
- Regenerate the lockfile from official 18.8.3 SDK packages and update installation and development docs.

## 1.10.0 - 2026-10-07

### Changed

- Base OhMyStash on our shared plugin SDK/framework. The renderer's modal API and `@hkay-dev/ohmystash/ui` give our plugins one popup contract and shared presentation defaults.

- Make the existing settings capture require a real packaged artifact and matching installed compiled OMP, with private HOME/XDG/agent roots instead of copied live configuration.
- Exercise stash/restore and browser shortcuts, retained synthetic storage and plugin settings without model inference. Keep source/fixture media separate from packaged consumer evidence.
- Install the packaged archive and exact matching SDK peers in the isolated consumer before registration; linking extracted bytes alone omits runtime dependencies.
- Move popup dimming into OMP's shared renderer, covering committed visible history, ANSI color formats, and native surfaces without wrapping terminal writes or clearing history.
- Use the shared opaque modal surface and one-cell black outer ring for the browser and selector dialogs. Backdrop settings now live in `tui.modal`; explicit legacy values migrate automatically.
- Require the matching modal-enabled `18.7.1-modal.0` SDK and OMP build.

### Checks

- 46 OhMyStash tests passed on macOS, with 12 Windows-only skips. The TypeScript check passed against the matching SDK archives.
- The shared SDK passed 444 tests. The installed compiled OMP walkthrough covered all three popup plugins, builtin dialogs, resize, nested popups, cancellation, and editor preservation.
- ANSI and native Tern visuals were checked. Native restoration was checked through the recorded close frame. No model inference was performed.

## 1.9.0 - 2026-10-04

### Changed

- Export the shared square popup UI from `@hkay-dev/ohmystash/ui`: `createFrame`, `fitToWidth`, `extensionIcon`, `selectOption`, and `POPUP_OPTIONS`. Consumers must install the package dependency rather than copy a standalone extension file.
- Center custom overlays at 90% of terminal width, with accent-colored square borders and embedded titles.
- Use contextual Nerd Font glyphs in the stash browser, honoring Show icons without changing OMP's global symbol preset. Keep native `/settings` → Plugins chrome.
- Retain existing stash/restore, chat scope, search, queue actions, attachments, editing, locks, deletion, recovery, retention, storage protections, and adaptive browser layouts.

### Checks

- Compiled OMP 18.6.1 loaded the installed npm archive; stash/restore, the browser, and the native plugin settings page were exercised.
- On macOS, 48 tests passed and 12 Windows-only tests were skipped. No model requests were made; backend integration was not tested.

## 1.8.8 - 2026-10-03

### Added

- Add Windows support through the built-in Windows PowerShell 5.1. OhMyStash uses PowerShell to set up and check private Windows ACLs for stash directories, prompts, and attachments. PowerShell 7 isn't required.

### Fixed

- Fix owner-only storage errors on Windows. Skip unsupported directory fsync on Windows while keeping file fsync enabled.
- Handle Windows short-path names and safe internal attachment hard links, including repeated images and missing display aliases.
- Keep Windows ACL changes inside the stash directory and reject links that lead outside it.

### Changed

- Keep the existing macOS and Linux ownership and POSIX permission checks unchanged.

### Checks

- All 54 tests and the TypeScript check passed locally on Windows, including native Windows PowerShell 5.1 storage checks.

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
