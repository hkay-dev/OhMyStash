---
title: Keys
feature: keys
covers:
  - extensions/prompt-stash.ts
  - extensions/native-ui.ts
since: 2026-08-22
description: Every OhMyStash shortcut, command and browser key in one place.
sidebar:
  order: 8
---

This page lists every key. The two shortcuts and the browser keys have their own pages with more detail.

## Anywhere in OMP

| Key or command | What it does |
| --- | --- |
| `Alt+S` | Stashes the prompt in the composer. With an empty composer, restores this chat's newest stash. See [Stash and restore a prompt](stash-and-restore.md). |
| `Alt+Shift+S` | Opens the [stash browser](browser/index.md) on stashes from every chat. |
| `/stash` | Opens the stash browser, the same as `Alt+Shift+S`. |
| `/stash restore` | Restores this chat's newest stash. The composer has to be empty. |

You can change `Alt+S` and `Alt+Shift+S`, or turn either one off, in [Settings](settings.md). A change applies in a new OMP session. The commands always work.

## In the stash browser

These keys work in the browser that opens inside OMP's terminal, when you're not typing a search.

| Key | What it does |
| --- | --- |
| `Up`, `Down` | Move through the list. |
| `Home`, `End` | Jump to the first or last stash. |
| `Enter` or `r` | Restore the selected stash. |
| `q` | Put the stash in the composer as an editable `/queue` draft. Its footer label is Draft. |
| `Q` (`Shift+Q`) | Submit the stash as a queue message and keep the browser open. Its footer label is Queue. |
| `p` | Pop: restore the stash and delete it. A locked stash stays. |
| `e` | Edit the stash. |
| `l` | Lock or unlock the stash. |
| `d` or `Delete` | Delete the stash. |
| `D` (`Shift+D`) | Clear every unlocked stash in the current scope. |
| `s` | Send the stash to another plugin. Only shows when a plugin offers a place. |
| `g` | Switch between all chats and this chat. |
| `/` | Start a search. |
| `[` or `PageUp` | Scroll the preview up. |
| `]` or `PageDown` | Scroll the preview down. |
| `Esc` | Clear the search if there is one, otherwise close the browser. |
| `Ctrl+C` | Close the browser. |

More on these: [restore, queue and pop](browser/restore-and-queue.md), [edit](browser/editing.md), [lock and delete](browser/lock-and-delete.md), [send](send-to-plugins.md).

## While searching

After you press `/`, every letter types into the search, `q` and `Q` included.

| Key | What it does |
| --- | --- |
| Any character | Types into the search. |
| `Up`, `Down` | Move through the matches. |
| `Enter` | Restore the selected match. |
| `Tab` | Keep the filter and leave the search field, so the letter keys work again. |
| `Esc` | Clear the search and leave the search field. |
| `Ctrl+C` | Close the browser. |

See [Search](browser/search.md).

## In the native browser

When a native host shows the browser, it uses these keys. Letters type into the search, so actions use modifier keys. On a Mac, `Cmd` is the Command key.

| Key | What it does |
| --- | --- |
| `Enter` | Restore. |
| `Shift+Enter` | Pop. |
| `Alt+Enter` | Draft to queue. |
| `Cmd+Shift+Enter` | Submit queue. Only for queue stashes. |
| `Cmd+Enter` | Send to another plugin. Only shows when a plugin offers a place. |
| `Cmd+E` | Edit. |
| `Cmd+L` | Lock or unlock. |
| `Cmd+Backspace` | Delete. Not available on a locked stash. It asks first. |
| `Cmd+Shift+Backspace` | Delete unlocked. It asks first. |

The native browser's two scopes are labeled This chat and All chats. See [The native stash browser](native-dialogs.md).
