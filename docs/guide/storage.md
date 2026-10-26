---
title: Where stashes live
feature: storage
covers:
  - extensions/prompt-stash.ts
since: 2026-08-22
description: Where OhMyStash keeps stashes and attachments, how it keeps saves safe, the limits and the automatic cleanup.
sidebar:
  order: 9
---

OhMyStash keeps everything on your own machine, in plain files. Nothing is sent anywhere.

## The folders

Stashes are in the `prompt-stash` folder inside OMP's agent folder:

```text
~/.omp/agent/prompt-stash/
```

Images and large pastes ([attachments](attachments.md)) are in a folder inside it:

```text
~/.omp/agent/prompt-stash/attachments/
```

Each stash is one small file. OhMyStash only uses folders that are private to your account. If a folder is open to other accounts, it says so and tells you how to fix it. See [Messages and fixes](troubleshooting.md). On Windows, see [Windows](windows.md).

## How saves stay safe

A save never writes straight over the stash it replaces.

- **Write, then swap.** OhMyStash writes the new version to a hidden working file, makes sure it reached the disk, and only then puts it in place. If OMP or the machine stops in the middle, you have the old version or the new one, never half of each.
- **Recovery files.** A hidden working file left behind by a crash isn't thrown away if it holds a complete stash. OhMyStash finds it the next time it loads your stashes and brings it back.
- **Conflict copies.** If two OMP sessions change the same stash at once, or an edit would push the store over its limit, nothing is overwritten. The edit is kept as a separate stash marked `[C]` in the browser, and a notification tells you. Conflict copies never expire.
- **Checks on the way in.** Attachments are stored under a fingerprint of their contents and checked when they're read. A file that has been changed or damaged is reported, not used.
- **Locked stashes** can't be deleted until you unlock them, and retention never removes them. See [lock and delete](browser/lock-and-delete.md).

## Limits

| What | Limit |
| --- | --- |
| Prompt text kept inside the stash | 1 MiB |
| One large pasted prompt, or one attachment | 64 MiB |
| Attachments in one stash, together | 128 MiB |
| Attachments in one stash | 64 |
| One stash's own file | 2 MiB |
| Normal stashes at once | 256 |
| All normal stashes' files, together | 16 MiB |
| All attachments, across every chat | 1 GiB |

Some of these need a word:

- Text over 1 MiB isn't kept in the stash file. It's stored as one attachment, up to 64 MiB, and counts as one of the 64 attachments and toward the 128 MiB.
- The 256 stashes and the 16 MiB count every normal stash from every chat, locked ones included. Delete stashes you don't need to make room.
- Conflict copies and recovery files load outside those two limits. They're never hidden because the store is full.
- An image you stash twice is stored once, so it counts once toward the 1 GiB.

When the store is full, the browser shows the newest stashes that fit and tells you how many older ones are hidden. A save that would go over a limit fails with a message instead. See [Messages and fixes](troubleshooting.md).

## Automatic cleanup

OhMyStash tidies up after itself.

- **Unused attachments.** After you delete stashes, pop one, or retention removes some, attachments that no stash uses any more are deleted once they're more than a minute old. A save that runs into the 1 GiB limit does this cleanup first and only then fails.
- **Crash leftovers.** Temporary attachment files left by a crash are deleted when they're a day old. A hidden working file that doesn't hold a complete stash is set aside after a day with `.orphan` added to its name, and deleted a week after that.
- **Damaged stash files.** A stash file that isn't valid is renamed with `.invalid` added to its name, once, so it stops warning you and stops counting against the limits. It's never deleted for you. Open the folder and delete it when you don't need it.
- **Old stashes.** With **Retention days** set, stashes you haven't used for that long are deleted. See [Settings](settings.md).

## Backups

These protections cover crashes and two sessions working at once. They don't cover a failed disk, a damaged filesystem or a lost laptop. Keep a separate backup of the stash folder if you can't afford to lose your stashes.
