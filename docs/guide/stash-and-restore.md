---
title: Stash and restore a prompt
feature: stash-and-restore
covers:
  - extensions/prompt-stash.ts
since: 2026-08-22
description: Save the prompt in your composer with Alt+S and bring this chat's newest stash back.
sidebar:
  order: 2
---

One key does both jobs. `Alt+S` stashes the prompt in your composer, or restores a stash when the composer is empty.

## Stash the prompt you're writing

1. Type a prompt in the composer. Add images or paste large text if you like.
2. Press `Alt+S`.

OMS saves the prompt and clears the composer. A notice tells you what was saved, for example `Prompt stashed (3 lines)`. With images or large pastes it adds the count, such as `Prompt stashed (3 lines with 2 attachments)`. Those come back with the prompt: see [Images and large pastes](attachments.md).

If there's nothing to stash, OMS says `Nothing to stash`.

## Restore the newest stash from this chat

1. Make sure the composer is empty.
2. Press `Alt+S`.

The newest stash from this chat goes back into the composer, and OMS says `Prompt restored from` and the time you stashed it. The stash stays saved. Restoring never deletes it, so you can restore it again later. To restore and remove it in one step, use pop in the [browser](browser/restore-and-queue.md).

If this chat has no stashes, OMS says `No stashed prompts in this chat.` When other chats have stashes, it adds how many (for example `3 stashes are available in other chats. Open the browser to pick one`). Press `Alt+Shift+S` to open the [stash browser](browser/index.md), which opens on stashes from every chat.

## Stashing the same draft twice

If you restore a stash and then stash the same prompt again without changing it, OMS keeps one stash instead of adding a copy. It says `Prompt was already this chat's latest stash, so OMS kept that one`.

This only applies to this chat's newest stash. A prompt that differs by even one character is saved as a new stash.

## `/queue` drafts

A prompt that starts with `/queue ` is a queue draft, and OMS keeps it as one. Stashing it clears the composer to `/queue `, ready for the next queued message. The notice says `Queue prompt stashed` instead of `Prompt stashed`.

When the composer holds only `/queue `, `Alt+S` restores this chat's newest queue stash, with `/queue ` in front. A normal stash isn't picked, even if it's newer. See [Restore, queue and pop](browser/restore-and-queue.md) for the other ways to use a queue draft.

## `/stash` and `/stash restore`

- `/stash` opens the [stash browser](browser/index.md), the same as `Alt+Shift+S`.
- `/stash restore` restores this chat's newest stash, the same as `Alt+S` on an empty composer.

Anything else after `/stash` shows `Usage: /stash or /stash restore`.

## When the composer isn't empty

`Alt+S` never overwrites your draft. With text in the composer it stashes that text instead of restoring.

`/stash restore` can't stash for you, so with text in the composer it stops and says `Stash or clear the current editor before restoring a prompt`. The same goes for restoring from the browser. A composer holding only images counts as a draft, so stash or clear it first.

## Change the shortcuts

`Alt+S` and `Alt+Shift+S` are the defaults. You can change either one, or turn it off, in [Settings](settings.md). `/stash` always works. For every key, see [Keys](keys.md).
