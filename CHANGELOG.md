# Changelog

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
