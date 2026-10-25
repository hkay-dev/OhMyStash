# Changelog

## Unreleased

### Added

- Another plugin can offer itself as a native UI host, for example when OMP runs inside a terminal app that can draw native dialogs. When one does, the stash browser opens as a native dialog, and restore, pop, queue, send, edit, lock and delete all work there with the same results and messages. If the host can't show the dialog, the browser opens in the TUI as before. Without a host, nothing changes.
- `@hkay-dev/ohmystash/native-ui` exports the bus channel and the types for plugin authors. [docs/native-ui.md](docs/native-ui.md) has an example and the key strings.

### Tested

- The TypeScript check, the browser and UI tests, and new tests that drive the browser through a fake host: restore closes it, lock lists it again with the same selection, delete skips the TUI confirmation, a failing host falls back to the TUI, and no host means no native browser.

## 1.15.0 - 2026-10-23

### Added

- Other plugins can offer places to send a stash. When one does, the browser shows `s` with its label, and `s` hands the selected stash's text to that plugin. With more than one, `s` asks which one. The composer draft stays as it is and the stash is kept, the same as after a restore. Without such a plugin, nothing changes.
- `@hkay-dev/ohmystash/send-targets` exports the bus channel and the types for plugin authors. [docs/send-targets.md](docs/send-targets.md) has an example.

### Tested

- The TypeScript check and the full test suite pass, with new tests for sending to one target, picking between two, and pressing `s` with none.

## 1.14.0 - 2026-10-19

### Why

It's easy to start typing a prompt in the wrong chat. Moving it used to take `Alt+S` to stash it, then `Alt+Shift+S` in the right chat, and then `g`, because the browser opened on the current chat, where that stash isn't. The browser now opens on every chat, so the prompt that you just stashed is the first row and `Enter` restores it.

### Changed

- The stash browser (`Alt+Shift+S` and `/stash`) opens on stashes from every chat. Press `g` to filter to the current chat, and again to go back. After an action, the browser still reopens on the scope that you left it on.
- `Alt+S` and `/stash restore` don't change. They still stash and restore only in the current chat.
- `Shift+D` on the default view now clears unlocked stashes across all chats. Its confirmation says so, and locked stashes are still protected. Press `g` first to clear only the current chat.
- Quota and empty-chat notices no longer tell you to press `g`, because the browser already shows every chat.

### Tested

- The TypeScript check and the full test suite pass, with the scope tests updated for the new default.
- On macOS with stock OMP 18.12.2, the packed 1.14.0 plugin, installed and loaded through OMP's plugin loader, stashed and restored with `Alt+S`, opened the browser on All chats with `Alt+Shift+S`, and restored with `Enter`. The release check now waits for All chats, and it fails against 1.13.0.
- A capture with 12 stashes from other chats showed the browser opening on All chats, `g` switching to This chat, and `g` switching back.

## 1.13.0 - 2026-10-17

### Windows performance

- Add an optional persistent Windows permission worker with a private per-OMP named pipe, owner-only access, client/server PID checks, bounded I/O, and shutdown/parent-exit cleanup. Every request still runs the existing ACL validator, and file fsync remains enabled.
- Build the worker with `bun run build:windows` on Windows. Generated executable/source files aren't committed. Unbuilt installs retain the existing PowerShell route; `OMS_ACL_TRANSPORT=oneshot` also selects that route.
- The Windows worker is platform-gated, and the POSIX permission path is unchanged. Tested on Windows, and on macOS with stock OMP 18.12.1: the full test suite, a packed-plugin startup with every module loaded, and stash, restore and browser actions in a private fixture.
- Add Windows regression coverage for unsafe paths, external hard links, foreign pipe clients, large replies, worker reuse/restart, missing-worker errors, and parent-exit cleanup.

### Changed

- Support OMP 18.12.1: SDK peers move to `^18.12.1`, pinned to 18.12.1 for development.

## 1.12.0 - 2026-10-13

### Added

- Press `p` in the browser to pop the selected stash: OMS restores it and then deletes it, unless it's locked.
- `@hkay-dev/ohmystash/ui`: `selectOption` takes `{ icons, selected }`, `ListOptions.icons` turns off the search glyph, and `ShortcutHintDeclaration` has an optional `command`, the slash command to show when a hint has no key. OhMyStash's browser hint declares `/stash`.
- Attachments count toward their own 1 GiB storage limit.

### Changed

- Stashing a draft that matches this chat's newest stash (same text, mode, and attachments) updates that stash instead of adding a copy.
- Retention counts from a stash's last restore or repeat stash, not only from when it was first saved.
- While you search in the browser, every printable key, `q` and `Q` included, types into the search. Press `Tab` to keep the filter and use the action keys again.
- `createList` and `showList`: printable keys always go to the search field while it has focus, and action keys do nothing while an async action is still running.
- The browser reopens on the stash you acted on, or on the same row once that stash is gone.
- Storage errors show the full path and the command that fixes it. The warning about stashes left out of the browser says why each one was left out.
- Requires OMP 18.10.4 or newer.

### Fixed

- Windows: the permission helper compiles its checks once and keeps them in the stash folder, and each action launches it once instead of two or three times.
- Deleting or expiring stashes also removes attachments nothing refers to anymore, stale attachment temps, and set-aside files older than a week.
- Saving an attachment whose stored copy is damaged rewrites the copy from the good bytes. Restoring a stash with a damaged attachment brings back the text and the attachments that still check out, and names the ones that don't.
- An unreadable stash file is renamed to `.invalid` once, so it stops counting toward the limit and the warning doesn't come back every time.
- When a stash changed in another session, the browser says so and reloads instead of failing.
- Subagent sessions no longer run OhMyStash's session work or reset its settings.
- Previews with a few non-ASCII lines are faster: only those lines are split into characters.
- Without an `id` option, the shared list finds the selected item again by its search text when `items()` builds new objects.

### Development

- Pin the 18.10.4 SDK packages and Bun 1.4.3.
- Move the release steps to `docs/releasing.md` and the UI reference to `docs/ui.md`. Neither ships in the install archive.
- Test repeat stashes, pop, retention, attachment cleanup and limits, damaged attachments, subagent sessions, typing into the browser search one key at a time, reselection and conflict reloads, storage error messages, and the cached Windows helper.

## 1.11.0 - 2026-10-13

### Added

- `formatShortcut` and `formatShortcutRange` in `@hkay-dev/ohmystash/ui` format OMP key ids such as `alt+shift+s` as Nerd Font Apple keyboard icons, or as plain text such as `Alt+Shift+S`. A run of three or more digit keys with the same modifiers collapses into a range such as `Alt+1-5`.
- `showList` opens a searchable list of any items in OMP's stock bottom overlay. It supports two-row items, footer actions that either close the list with a result or keep it open, and an optional key that closes it, such as the shortcut that opened it. It fits short and narrow terminals and keeps the selected item in the middle while paging. `createList` returns the same list as a component for use inside another overlay component.
- Plugins can list their shortcut settings in a top-level `hkay.shortcutHints` field of `package.json`, typed by the new `ShortcutHintDeclaration` export, so other plugins can read and show them. OhMyStash declares its stash and browser shortcuts there.

### Changed

- `selectOption` now runs on the shared list. Its rows, keys, and results are unchanged.

### Development

- Test shortcut formatting, the list at many terminal sizes, its keys and actions, and that `selectOption` draws exactly what 1.10.4 drew for the same keys.

## 1.10.4 - 2026-10-12

### Changed

- Support stock OMP 18.10.3. The SDK peers now require `^18.10.3`. OhMyStash needed no code changes: stash and restore, the browser, settings, and the `@hkay-dev/ohmystash/ui` exports work as in 1.10.3.

### Development

- Pin the official 18.10.3 SDK packages and regenerate the lockfile from the stock registry.
- Point the packaged installed-runtime proof recipe at OMP 18.10.3 and its tagged docs.

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
