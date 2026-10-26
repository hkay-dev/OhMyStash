---
title: Edit a stash
feature: edit-stash
description: Change a saved prompt from the browser, in your own editor or OMP's.
covers:
  - extensions/prompt-stash.ts
since: 2026-08-22
sidebar:
  order: 4
---

Select a stash in the [stash browser](index.md) and press `e` to change its text. It works on any stash, including [locked](lock-and-delete.md) ones, and a locked stash stays locked.

![Editing a stash from the browser](../../../assets/ohmystash-feature-editing.gif)

## Which editor opens

OMS picks the first of these that applies:

1. The **Editor command** setting (see [settings](../settings.md)), for example `code --wait`.
2. The `$VISUAL` environment variable.
3. The `$EDITOR` environment variable.
4. OMP's built-in editor, in a dialog titled `Edit stashed prompt`.

With a command, OMS pauses OMP's screen, opens a Markdown file with the stash's text in that editor, and takes the screen back when you close it. The command has to wait until you close the file, which is why GUI editors need a flag like `--wait`. Editors such as vim and nano add a final newline when they save. OMS drops it unless the stash already ended with one, so quitting without changes leaves the stash untouched.

A large pasted prompt opens with its full text, not the `[Large pasted prompt ...]` placeholder.

## What happens when you finish

- **You save a change.** OMS stores the new text and says `Stashed prompt updated`. The stash keeps its lock, its mode, its chat and its images.
- **You leave the text as it was.** OMS says `Stashed prompt unchanged` and writes nothing.
- **You cancel.** Closing the built-in editor with `Esc` says `Stashed prompt edit cancelled`.
- **You empty it.** A stash with no images can't become empty. OMS shows `OMS failed: An attachment-free stash cannot be edited to an empty prompt` and keeps the old text. To get rid of a stash, [delete it](lock-and-delete.md). A stash with images can have its text emptied, because the images are still there.

After any of these the browser reopens on the same stash.

## When another session changed it

If another OMP session changed the stash while you were editing, OMS doesn't overwrite that change. Your edit is saved as a new stash instead, marked `[C]` in the list, and OMS says `Stash changed concurrently; edited text was preserved as a new stash`. Compare the two and delete the one you don't want.

If your stash storage is full, the same thing happens with a warning: `OMS storage quota reached; edited text was preserved as a new stash`. See [where stashes live](../storage.md) for the limits.
