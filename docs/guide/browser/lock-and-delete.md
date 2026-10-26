---
title: Lock and delete
feature: lock-and-delete
description: Protect a stash with a lock, delete one stash, or clear every unlocked stash in view.
covers:
  - extensions/prompt-stash.ts
since: 2026-08-22
sidebar:
  order: 5
---

Stashes pile up. The [stash browser](index.md) lets you delete the ones you're done with and lock the ones you want to keep.

![Locking and deleting stashes](../../../assets/ohmystash-feature-locking-deletion.gif)

## Lock a stash

Press `l` on the selected stash. OMS says `Stash locked`, and the list shows `[L]` next to it. Press `l` again to unlock it (`Stash unlocked`).

A lock protects the stash from:

- **Delete.** `d` or `Delete` refuses a locked stash with `Unlock this stash before deleting it`.
- **Clear.** `Shift+D` skips locked stashes and tells you how many it kept.
- **Pop.** `p` restores a locked stash but keeps it. See [restore, queue and pop](restore-and-queue.md).
- **Retention.** Stashes older than the **Retention days** setting are removed automatically, but never locked ones. See [settings](../settings.md).

A lock doesn't stop you editing. See [edit a stash](editing.md).

## Delete one stash

Press `d` or `Delete` on a stash that isn't locked. OMS asks:

> **Delete stashed prompt?**
> Permanently delete "<first line>" from <time>?

In the all-chats view the question also names the chat. The answer starts on No, so pressing `Enter` straight away keeps the stash. Choose Yes and OMS says `Deleted stashed prompt`. Images and pastes that no other stash uses are cleaned up with it (see [images and large pastes](../attachments.md)). If another session already deleted it, you see `Stash entry was already deleted`.

## Delete every unlocked stash in view

Press `Shift+D`. It acts on the current scope: the stashes of this chat after `g` switches to the current chat, or every chat in the all-chats view. A search filter doesn't narrow it, and the dialog says so. The dialog is titled `Delete unlocked stashes from this chat?` or `Delete unlocked stashes across all chats?`, and reads:

> Permanently delete 12 unlocked stashed prompts from this chat? 2 locked stashes are protected. This ignores the current search and cannot be undone.

The answer starts on No. After you confirm, OMS says `Deleted 12 unlocked stashed prompts; 2 locked protected`. If a stash changed or got locked in another session in the meantime, it's kept, and the message reads `Deleted 11 of 12 unlocked stashed prompts; 2 locked protected`.

When every stash in view is locked, nothing opens and OMS says `Every stash is locked; nothing was deleted`.

Deleted stashes can't be brought back.
