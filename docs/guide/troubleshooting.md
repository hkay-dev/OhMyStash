---
title: Messages and fixes
feature: troubleshooting
covers:
  - extensions/prompt-stash.ts
  - extensions/storage-permissions.ts
since: 2026-08-22
description: Every message OhMyStash can show you, what it means and what to do about it.
sidebar:
  order: 10
---

OhMyStash shows its messages as OMP notifications. A message that starts with `OMS failed:` means the action stopped and nothing was changed. Every other message is a warning or a note, and the action it comes with went ahead.

Paths below are the default ones. Yours may differ, and the message always has your own. In the messages, `...` stands for the part that changes.

## Storage folder problems

These stop an action, so you see them after `OMS failed:`.

### OMS failed: OMS storage directory is shared with other accounts. Run: chmod 700 '...'

OhMyStash only uses a stash folder that other accounts can't open, and this one lets them in. This usually happens after copying the folder with `cp -r` or a sync tool. Run the command from the message. It has your full path. The attachments folder gets the same message with `OMS attachment directory` at the start and its own path.

### OMS failed: OMS storage directory belongs to another account. Run: sudo chown -R "$(id -un)" '...'

Another user created the folder, for example because OMP ran once with `sudo`. The command in the message gives it back to you.

### OMS failed: OMS storage directory ... is a symbolic link. Replace it with the real directory

OhMyStash doesn't follow links for its storage. Move the real folder to that path.

### OMS failed: OMS storage directory ... is not a directory. Move it aside so OMS can create the directory

Something that isn't a folder is sitting where the stash folder should be. Move or rename it, and OhMyStash creates the folder on the next save.

### OMS failed: OMS storage directory ... must be private to your account (...). Remove other accounts from its Security settings

This one is Windows only. Open the folder's Properties, choose Security, and leave only your own account. OhMyStash sets up new folders this way by itself. The reason in brackets can help if the folder looks right to you. See [Windows](windows.md).

### OMS failed: OMS stash file is shared with other accounts. Run: chmod 600 '...'

A single stash file can be read by other accounts, so OhMyStash won't change it. Run the command from the message. On Windows the message tells you which file to remove other accounts from instead.

## Hidden and damaged stashes

These are warnings. They show when the browser loads your stashes.

### 3 OMS stashes are hidden because their files are shared with other accounts. Run: chmod 600 '...'/*.json

Those stash files can be read by other accounts, so OhMyStash keeps them out of the browser until you fix them. Run the command from the message. With one stash the message says `1 OMS stash is hidden because its file is shared with other accounts`.

### 2 damaged OMS stash files were set aside in ... with an .invalid or .orphan suffix

Those files weren't valid stashes, for example after a disk error or a sync conflict. OhMyStash renamed them once and won't mention them again. Open the folder and look inside if you want, then delete them. See [Where stashes live](storage.md).

### 1 OMS stash file in ... couldn't be loaded. It may come from a newer OhMyStash

The file is valid, but this version doesn't understand it, so OhMyStash leaves it alone. With more than one file the message says `files ... They may come`. Update OhMyStash. See [Install and update](install.md).

### 5 older OMS stashes are hidden because the store is over its limit of 256 stashes or 16 MiB. Delete stashes you don't need to bring them back

The browser shows the newest stashes that fit. Delete or pop stashes you no longer need and the older ones come back.

## Storage is full

### OMS failed: OMS storage quota reached across all chats. Open the stash browser to manage it

A new stash would take you over 256 stashes or 16 MiB. Open the [stash browser](browser/index.md), switch to all chats and delete what you don't need. Locked stashes count too, so unlock the ones you can let go of first.

### OMS failed: OMS attachment storage is full (1 GiB across all chats). Open the stash browser and delete stashes with images or large pastes

Your stashed images and large pastes add up to 1 GiB. OhMyStash already cleaned up unused attachments before saying this, so delete stashes that carry big attachments. Stashes without new attachments still save.

### OMS storage quota reached; edited text was preserved as a new stash

This is a warning. You edited a stash and the new text wouldn't fit under the limit, so the edit was saved as a separate conflict copy marked `[C]` instead of replacing the original. Delete stashes you don't need, then copy what you want from the conflict copy.

## Things that are too big

These stop the stash. Each names the limit it hit. The limits are in [Where stashes live](storage.md).

### OMS failed: An OMS attachment exceeds the 64 MiB limit

### OMS failed: Large pasted prompt exceeds the 64 MiB text attachment limit

### OMS failed: OMS attachments exceed the 128 MiB per-entry limit

### OMS failed: An OMS entry can contain at most 64 attachments

A single attachment or large paste is over 64 MiB, the attachments in one stash add up to more than 128 MiB, or the stash has more than 64 attachments. Stash the prompt with fewer or smaller attachments. Large pasted text counts as one attachment.

### OMS failed: Serialized prompt is too large to stash safely

### OMS failed: Edited prompt is too large to persist safely

### OMS failed: Edited prompt exceeds the file-backed attachment limit

The stash, or the stash after your edit, is bigger than one stash file may be, or its text is over 64 MiB. Shorten the prompt.

## Restoring

### Prompt restored from ..., but couldn't restore Image #2 (damaged)

This is a warning. The same shape comes with `Restored prompt from ...` from the browser, and `Inserted queued draft from ...` for a queue stash. The stored copy of that attachment failed its checks, so OhMyStash restored everything else and left a plain `[Image #2 unavailable]` note where the image was. The reason in brackets is one of `damaged`, `missing` or `shared with other accounts`. A large paste says `the large pasted text` instead of an image number. Stashing the same image again repairs a damaged copy. A pop keeps a stash whose attachments didn't all come back, so you can try again. See [Restore, queue and pop](browser/restore-and-queue.md).

### Inserted the queued draft without submitting it, because it's missing ... The stash file is unchanged

You pressed `Shift+Q` on a stash with an attachment that couldn't be restored. OhMyStash put the draft in the editor instead of submitting it, so you can look first. The stash file is untouched.

### Stash or clear the current editor before submitting a queued stash

### Stash or clear the current editor before restoring a prompt

This is a warning. Restoring or submitting would write over what's in the editor. Stash it with your stash shortcut, or clear it, and try again.

### That stash changed in another session, so OMS reloaded the browser

Another OMP window locked, edited or deleted that stash after your browser loaded it. Nothing was overwritten. Try again on the reloaded list.

### Restored prompt from ..., but kept the stash because it changed in another session

You popped a stash that another session changed in the meantime. The prompt is in your editor, and the stash stays so no change is lost.

### Stash changed concurrently; edited text was preserved as a new stash

Another session changed the stash while you were editing it. Your text was saved as a separate conflict copy marked `[C]`, and the other session's version is untouched.

## After an install or update

### OMS failed: Restart OMP once so OhMyStash can attach to the native editor

### OMS failed: Restart OMP once so OhMyStash can restore native attachments

### OMS failed: Restart OMP once so OhMyStash can submit queued stashes

OhMyStash attaches to OMP's editor when a session starts. A session that was already open when you installed or updated it hasn't attached. Quit OMP and start it again.

## Deleting

### Unlock this stash before deleting it

A warning. A locked stash can't be deleted, so unlock it first. See [Lock and delete](browser/lock-and-delete.md).

### Every stash is locked; nothing was deleted

A warning when you delete every stash from the browser. That action only deletes stashes that aren't locked, and there weren't any.

## Anything else

### Usage: /stash or /stash restore

You typed `/stash` followed by something else. Use `/stash` to open the browser, or `/stash restore` to put the latest stash from this chat back in the editor.
