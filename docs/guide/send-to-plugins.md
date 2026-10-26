---
title: Send a stash to another plugin
feature: send-to-plugins
covers:
  - extensions/send-targets.ts
  - extensions/prompt-stash.ts
since: 2026-10-23
description: Hand a stash's text to another installed plugin from the browser.
sidebar:
  order: 5
---

Another plugin you've installed can offer a place to send a stash, such as a notes app or a task list. When one does, the stash browser gets one more key, `s`, and it hands the selected stash to that plugin.

## Send a stash

1. Open the browser with `Alt+Shift+S` or `/stash`.
2. Select the stash you want. [Search](browser/search.md) first if the list is long.
3. Press `s`.

The browser closes and the plugin receives the stash's full text, with large pastes expanded. If the stash has images, the image markers such as `[Image #1]` stay in the text, but the images themselves aren't sent.

## What the footer shows

The footer shows `s` next to the plugin's own label, for example `s Notes`.

With more than one plugin offering a place, the footer shows `s Send` instead. Press `s` and a `Send stash to` picker lists the labels. Type to narrow the list, then press Enter on the one you want. Esc closes the picker and sends nothing.

## What stays as it is

- The text you're typing in the composer isn't touched.
- The stash stays in your list, the same as after a restore, and its last-used time updates.
- Images stay behind in the stash.

Your plugin decides what to do with the text. If it fails, OhMyStash shows the error.

## Without such a plugin

If no installed plugin offers a place, `s` isn't shown in the footer and pressing it does nothing. Nothing else about the browser changes.

## In the native browser

The [native stash browser](native-dialogs.md) has the same action. It shows the plugin's label, or `Send` when there are several, and uses `Cmd+Enter`, because letters type into the search there. With several places, a `Send stash to` list opens with a `Send` action.

To offer a place from your own plugin, see [for plugin authors](for-plugin-authors.md).
