---
title: Search
feature: stash-search
covers:
  - extensions/prompt-stash.ts
  - extensions/ui.ts
since: 2026-08-22
description: Find a stash by what it says, where it came from, or when you made it.
sidebar:
  order: 2
---

When you have a lot of stashes, search narrows the [stash browser](index.md) to the ones you mean.

![Searching the stash browser across all chats](../../../assets/ohmystash-feature-search.gif)

## Start a search

1. Open the browser with `Alt+Shift+S` or `/stash`.
2. Press `/`. A search line appears under the title, with the count of matches, such as `4/27 matches`.
3. Type what you remember.

The list narrows as you type and the first match is selected. The preview shows it.

## What it matches

Search looks at:

- The prompt text.
- The time the stash was made, as the browser shows it.
- Whether it's a queue draft or a normal prompt: type `queue` to find queue drafts.
- Whether it's locked: type `locked`.
- Whether it's a conflict copy: type `conflict`.
- Its attachments: type `image` for pasted images, `paste` for large pastes, or an image type such as `png`.

On **All chats**, search also looks at the chat name, the workspace, the first 8 characters of the session id and the session id in full. So you can type a project's folder name to see every stash from that workspace. On **This chat**, every stash is from the same chat, so only the first list applies.

Case doesn't matter.

## How matching works

Search first looks for your text exactly as you typed it, anywhere in the stash. If something matches, you see those stashes.

If nothing matches, search tries again and forgives typos and missing letters, so `prmpt` still finds a stash with `prompt` in it. For a very long prompt, this second pass only reads its beginning and its end. The exact pass reads all of it.

## Pick a match

While you type, every letter goes into the search, including `q`, `Q` and the other letters that do things in the browser. That means you can search for any word.

- `↑` and `↓` move through the matches.
- `Enter` restores the selected match. See [restore, queue and pop](restore-and-queue.md).
- `Tab` stops typing and keeps the filter. The list stays narrowed, and the letter keys work again, so you can press `e` to edit, `l` to lock or `d` to delete the match. See [edit a stash](editing.md) and [lock and delete](lock-and-delete.md).
- `Esc` clears the search and shows every stash again.

When you aren't typing, `Esc` does the same thing while a filter is on: it clears the search. Press `Esc` once more to close the browser.

While you type, the footer shows `Tab Select`, `Esc Clear` and `↑↓ Navigate`, and the action line shows only `Enter Restore`.

## Switch scope while searching

Press `Tab` first, then `g`, to switch between All chats and This chat. The filter stays and runs again on the other scope. The count, such as `4/27 matches`, says how many of that scope's stashes match. See [All chats and This chat](index.md).

If nothing matches you see `No prompts match this search`. Change the text or press `Esc` to clear it.

The browser keeps your search when it reopens after an action, so you can restore or edit several matches in a row.
