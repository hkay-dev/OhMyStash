---
title: Settings
feature: settings
covers:
  - package.json
  - extensions/prompt-stash.ts
since: 2026-08-22
description: Every OhMyStash setting, what it changes and how to set it from OMP or the command line.
sidebar:
  order: 7
---

OhMyStash has eight settings. They cover the two shortcuts, the editor used for edits, how the browser looks, and how long old stashes are kept.

## Open the settings

1. In OMP, type `/settings` and press `Enter`.
2. Choose **Plugins**.
3. Select `@hkay-dev/ohmystash` and press `Enter`.

![OhMyStash settings in OMP](../../assets/ohmystash-settings.png)

Settings load when a new OMP session starts. After you change one, start a new session to see it take effect. That's true for the shortcuts in particular.

## The settings

| Setting | Choices | Default |
| --- | --- | --- |
| Stash shortcut | A key combination, or `none` | `alt+s` |
| Browser shortcut | A key combination, or `none` | `alt+shift+s` |
| Editor command | Any command, or blank | blank |
| Browser layout | Automatic, Side by side, Stacked, Compact | Automatic |
| Maximum body rows | A whole number from 6 to 72 | 36 |
| Time format | 12-hour clock, 24-hour clock | 12-hour clock |
| Retention days | A whole number from 0 to 3650 | 0 |
| Show icons | On or off | On |

### Stash shortcut

Stashes the prompt in the editor. When the editor is empty, it restores the latest stash from this chat instead. Enter `none` to turn the shortcut off. Key names are lowercased, so `Alt+S` and `alt+s` are the same. A blank value goes back to the default.

### Browser shortcut

Opens the [stash browser](browser/index.md). Enter `none` to turn it off. The `/stash` command still works either way. A blank value goes back to the default.

### Editor command

The command the browser runs when you press `e` to [edit a stash](browser/editing.md), for example `nvim` or `code --wait`. Use a command that waits until you close the file. Blank uses the editor OMP has registered from `VISUAL` or `EDITOR`, and if there isn't one, OMP's built-in multi-line editor.

### Browser layout

How the list and the preview sit in the browser.

- **Automatic** picks a layout to fit the terminal's size: side by side on wide terminals, stacked on narrower ones.
- **Side by side** puts the list on one side and the preview on the other. It needs a terminal at least 72 columns wide, and falls back to stacked below that.
- **Stacked** puts the preview under the list.
- **Compact** shows one stash at a time, with its position in the list, instead of a list and a full preview. A very small terminal switches to it by itself.

### Maximum body rows

Caps the height of the list and preview area. Numbers outside 6 to 72 are pulled back into that range, and decimals are rounded. The default of 36 is twice the browser's original height.

### Time format

Whether exact timestamps in previews and notifications use a 12-hour or a 24-hour clock.

### Retention days

Deletes old stashes after this many days. `0` keeps them forever.

The days count from the last time you stashed or restored a prompt, so a stash you keep reusing doesn't expire. Restoring, popping a stash that stays because it's locked, sending it to another plugin and stashing the same prompt again all count as use.

Retention removes only stashes that are expired, unlocked and normal. Locked stashes, conflict copies and recovery entries never expire. It runs when OhMyStash loads your stashes, which includes the start of each new session when retention is on. When it deletes a stash, attachments nothing else uses are cleaned up too. See [Where stashes live](storage.md).

### Show icons

Uses Nerd Font icons in the browser. Turn it off if your terminal font doesn't have them.

## Set them from the command line

Every setting is also available through `omp plugin config`. Use the exact label in quotes.

```sh
omp plugin config list @hkay-dev/ohmystash
omp plugin config set @hkay-dev/ohmystash "Browser layout" "Stacked"
omp plugin config set @hkay-dev/ohmystash "Retention days" 30
omp plugin config set @hkay-dev/ohmystash "Editor command" "code --wait"
omp plugin config delete @hkay-dev/ohmystash "Browser layout"
```

`delete` puts a setting back to its default. A value OhMyStash can't use, such as text in a number setting, is ignored and the default applies.
