---
title: The native stash browser
feature: native-dialogs
covers:
  - extensions/native-ui.ts
  - extensions/prompt-stash.ts
since: 2026-10-25
description: Open the stash browser as a native dialog when your terminal app offers one.
sidebar:
  order: 6
---

When OMP runs inside a terminal app that can draw its own windows, and that app's plugin offers itself to OhMyStash, the stash browser opens as a native dialog instead of the overlay in the terminal.

## Open it

Nothing to set up in OhMyStash. Press `Alt+Shift+S` (or whatever you set as the browser shortcut) or run `/stash`. If a native host is there, the dialog opens. If not, you get the usual [stash browser](browser/index.md) overlay.

If the app can't show the dialog, the overlay opens instead, without a message. With no stashes, you get `No stashed prompts` either way.

## The dialog

The dialog is titled OhMyStash, with a `Search stashes` field, a `This chat` and `All chats` switch, and a preview of the selected stash. It opens on `All chats`. Each row shows the headline, where the stash came from, and its age. Small symbols mark locked stashes, stashes with attachments and stashes OhMyStash preserved past the storage limit. Up and Down move, Tab switches between the two scopes, and Esc clears the search, then closes the dialog. With nothing in the chat, the list says `No stashed prompts in this chat`.

Every action does the same thing, with the same messages, as in the overlay. See [restore, queue and pop](browser/restore-and-queue.md), [edit a stash](browser/editing.md) and [lock and delete](browser/lock-and-delete.md).

## Keys

Letters type into the search in the dialog, so the actions use key combinations in the native app's style instead of single letters.

| Key | Action |
| --- | --- |
| `Enter` | Restore |
| `Shift+Enter` | Pop |
| `Alt+Enter` | Draft to queue |
| `Cmd+Shift+Enter` | Submit queue (queue stashes only) |
| `Cmd+Enter` | Send, or the plugin's label (only when another plugin [offers a place](send-to-plugins.md)) |
| `Cmd+E` | Edit |
| `Cmd+L` | Lock, or Unlock on a locked stash |
| `Cmd+Backspace` | Delete (not shown for locked stashes) |
| `Cmd+Shift+Backspace` | Delete unlocked, for the scope you're in |

Restore, Pop, Draft to queue, Submit queue and Send close the dialog. Edit, Lock, Unlock and the deletes keep it open, and it updates with your selection and search kept.

## Edit and delete dialogs

Edit opens a text editor titled `Edit stashed prompt` with a `Save` button. Cancelling, or saving without changes, leaves the stash alone and shows a message.

Delete asks first in the app's own dialog: `Delete stashed prompt?` with `Permanently delete “<headline>”?` and a Delete button. Delete unlocked asks `Delete unlocked stashes?`, says locked stashes are protected and that it ignores the current search, and can't be undone. The overlay's own confirmation isn't shown on top of these.

A stash that changed in another OMP session while the dialog was open makes the dialog reload, with `That stash changed in another session, so OMS reloaded the browser`.

If you write a terminal app plugin, see [for plugin authors](for-plugin-authors.md).
