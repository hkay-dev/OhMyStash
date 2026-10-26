---
title: Restore, queue and pop
feature: restore-and-queue
description: Bring a stash back into the composer, as a draft, as a queued message, or as a pop that deletes it.
covers:
  - extensions/prompt-stash.ts
since: 2026-08-22
sidebar:
  order: 3
---

Open the [stash browser](index.md), pick a stash, and press one key to bring it back into the composer. Every key below works while the list has focus. While you're typing in the search field, letters go into the search, so press `Tab` first to get them back (see [search](search.md)).

## The composer has to be empty

Restoring, queueing and popping only work on an empty composer. A draft that holds only images counts as content too. If the composer isn't empty, OMS shows this warning and leaves the stash and your draft alone:

```
Stash or clear the current editor before restoring a prompt
```

`Shift+Q` shows its own version of the same warning: `Stash or clear the current editor before submitting a queued stash`. Stash your draft with `Alt+S` (see [stash and restore](../stash-and-restore.md)) or clear it, then try again.

## The four ways back

| Key | What it does | Stash afterwards |
| --- | --- | --- |
| `Enter` (or `r`) | Restores the prompt into the composer | Stays |
| `q` | Puts it in the composer as an editable `/queue` draft | Stays |
| `Shift+Q` | Adds `/queue ` and submits it, keeping the browser open | Stays |
| `p` | Restores it, then deletes the stash | Deleted, unless locked |

A stash that was saved as a `/queue` draft comes back with `/queue ` in front when you press `Enter` too. The `q` key adds the prefix to any stash.

### Restore

Press `Enter`. The prompt lands in the composer, with its [images and large pastes](../attachments.md), and the browser closes. OMS says `Restored prompt from <time>; restore never deletes stash files`. Restoring never removes the stash, so you can bring it back again later.

### Queue draft

Press `q`. The stash goes into the composer as a `/queue` draft you can still change before you send it. OMS says `Inserted queued draft from <time>; stash file retained`.

![An editable queue draft in the composer](../../../assets/ohmystash-feature-queue-draft.gif)

### Submit to the queue

Press `Shift+Q`. OMS puts `/queue ` in front of the stash and submits it straight away. The browser stays open on the same stash, so you can press `Shift+Q` again to stack more messages in OMP's queue. Press `Esc` when you're done.

![A stash submitted as a queue message](../../../assets/ohmystash-feature-submit-queue.gif)

If one of the stash's attachments can't be read, OMS doesn't submit a partial prompt. It puts the stash in the composer as a draft instead, closes the browser, and says:

```
Inserted the queued draft without submitting it, because it's missing <what's missing>. The stash file is unchanged
```

Check the draft, then send it yourself if it still makes sense.

### Pop

Press `p`. OMS restores the prompt and deletes the stash, and says `Popped prompt from <time>; the stash is deleted`. A pop keeps the stash in three cases, and tells you which:

- The stash is locked. You see `Restored prompt from <time>; locked stashes stay after a pop`. See [lock and delete](lock-and-delete.md).
- An attachment couldn't be restored, so the stash is the only good copy. You get the restore warning described in [images and large pastes](../attachments.md).
- Another OMP session changed the stash since the browser loaded it. You see `Restored prompt from <time>, but kept the stash because it changed in another session`.

## Next

- [Edit a stash](editing.md) before you restore it.
- [Lock and delete](lock-and-delete.md) stashes you want to protect or remove.
