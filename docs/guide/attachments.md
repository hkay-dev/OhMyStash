---
title: Images and large pastes
feature: attachments
description: What happens to pasted images and collapsed large pastes when you stash and restore a prompt.
covers:
  - extensions/prompt-stash.ts
since: 2026-08-22
sidebar:
  order: 4
---

Images you've pasted into the composer and large pastes that OMP collapsed into a `[Paste #N]` chip are saved with the stash and come back with it.

![Attachments coming back with a stash](../../assets/ohmystash-feature-attachments.gif)

## What gets saved

- **Images.** Each image in the draft is saved with the stash. Only images the text still refers to are kept, so an image whose chip you deleted is left out. Images are renumbered when they come back, so a stash with one image left reads `Image #1`.
- **Collapsed pastes.** A `[Paste #N]` chip is saved with its full text and expands again on restore.
- **Very large prompts.** A prompt over 1 MiB is saved as a file, and the list shows `[Large pasted prompt · <lines> lines · <chars> chars]` in its place. Restoring puts the full text back.

A stash with attachments shows `+<count>` in the list. You can search for attachments too (see [search](browser/search.md)).

## The same image twice

An image is stored once, however many stashes use it. Stash the same screenshot five times and it takes the room of one, and it counts once against the limits.

## When an attachment is damaged or missing

OMS checks every attachment on the way back. If one is damaged, missing, or readable by other accounts, the rest of the prompt still restores. The text that referred to the bad image shows `[Image #2 unavailable]`, and OMS warns you:

```
Restored prompt from <time>, but couldn't restore Image #2 (damaged)
```

The reason is `damaged`, `missing` or `shared with other accounts`. A large pasted text that can't be read is named `the large pasted text`.

A few things follow:

- A pop keeps the stash when an attachment is missing, so you don't lose the only copy. See [restore, queue and pop](browser/restore-and-queue.md).
- `Shift+Q` doesn't submit a prompt that's missing something. It puts the draft in the composer for you to check.
- To repair a damaged image, stash the same image again. OMS notices the stored copy fails its check and replaces it with the good one, and every stash that used it works again.

## Limits per stash

One stash can hold up to 64 attachments and 128 MiB of attachments in total, and no single attachment can pass 64 MiB. A stash that goes over is refused with a message saying which limit it hit. The limits across all stashes and the storage folder are on [where stashes live](storage.md).
