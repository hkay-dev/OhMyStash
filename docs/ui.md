# Shared picker UI

OhMyStash exports its picker helpers at `@hkay-dev/ohmystash/ui`, so other OMP plugins can draw the same frames, lists, and key labels. They use only stock public SDK exports.

To use them, add OhMyStash as a package dependency of your plugin, for example `github:hkay-dev/OhMyStash#v1.12.0`. OMP installs declared dependencies through its normal package manager before it loads your extension. Copying a single extension file, or linking extracted files without installing dependencies, doesn't supply the module.

## Exports

- `OVERLAY_OPTIONS` is `{ overlay: true }`, the `ctx.ui.custom` options for OMP's stock bottom overlay. Like Switch Model, it spans the full width, can use every terminal row, and adds no backdrop. Closing it leaves the composer's draft, caret, and undo history alone.
- `createFrame(theme, width)` returns square, accent-colored `top`, `row`, `divider`, and `bottom` renderers, with the title in the top border and content clipped to the terminal width.
- `fitToWidth(text, width)` clips and pads text to a visible terminal width, counting ANSI styling and wide characters correctly.
- `extensionIcon(key)` reads the Nerd Font symbol preset and returns an empty string for an unknown key. It doesn't change the host's symbol preset or read your Show icons setting, so check that setting yourself.
- `selectOption(ctx, title, options, iconKey?, settings?)` opens a searchable picker in the overlay and resolves to the chosen string, or `undefined` when it's cancelled. `settings` is optional:
  - `icons` (default `true`): `false` drops the Nerd Font title glyph and draws a `/` instead of the search glyph. Pass your Show icons setting.
  - `selected`: the option to select when the picker opens. If it isn't one of the options, the first one is selected.
- `showList(ctx, options)` opens a searchable list of any items in the overlay. It resolves to the result of the footer action that closed it, or `undefined` when Esc, Ctrl+C, or the optional `toggleKey` closes it.
- `createList(tui, theme, options, done)` returns the same list as a component, for a plugin that shows it inside its own overlay component. Its `select(item)` moves the selection.
- `formatShortcut(key, { icons })` formats an OMP key id such as `alt+shift+s`. By default it draws Nerd Font Apple keyboard icons in macOS menu order, separated by spaces. With `icons: false` it gives plain text such as `Alt+Shift+S`. A blank key or `none` gives an empty string.
- `formatShortcutRange(keys, { icons })` formats several keys and skips blank and `none` keys. Three or more keys with the same modifiers and consecutive digits collapse into one range, such as `Alt+1-5`.
- `ShortcutHintDeclaration` types one entry of the `hkay.shortcutHints` package field described below.

## List options

| Option | Meaning |
| --- | --- |
| `items` | The items, or a function that returns the current items of a list that changes while it's open. |
| `title` | The frame title, or a function of `{ query, matches, total, selected }`, for example to show match counts. |
| `renderItem(item, { width, selected, theme, compact })` | One row per item, or two rows for two-line items. The compact layout shows only the first row. |
| `search(item)` | The text that every search word must appear in, ignoring case. Defaults to `String(item)`. |
| `filter(items, query)` | Replaces that search with your own matching and order. |
| `id(item)` | Keeps the selection on the same item when the items change. Pass it when `items()` builds new objects. Without it, the selection follows the same object, or else the first item with the same search text. |
| `selected` | The item to select when the list opens. |
| `emptyLabel` | Shown when nothing matches. A function gets the same state as `title`. |
| `prompt`, `placeholder` | The label before the search field (default `Search`) and the dim text in the empty field. |
| `icons` | Draws the Nerd Font search glyph before the label. Defaults to `true`; pass your Show icons setting. |
| `actions` | Footer actions, `{ key, label, run(item) }`. See below. |
| `toggleKey` | Another key that closes the list, such as the shortcut that opened it. Blank or `none` adds no key. |

## Keys and actions

Up and Down move the selection, PgUp and PgDn move a page, and Home and End jump to either end. Esc and Ctrl+C close the list.

The search field has focus while the list is open, so a bare printable key always types into the search. That covers letters, digits, symbols, shifted letters such as `Q`, and `space`, and it holds even when an action uses that key. Give actions `enter`, `tab`, another named key, or a combination with ctrl, alt, or super, such as `ctrl+o` or `alt+d`. The primary action uses `enter`.

`run` gets the selected item, or `undefined` when nothing matches. Return a result to close the list with it, or `undefined` to keep the list open and repaint it. A returned promise is awaited, and action keys do nothing until it settles, so a second Enter can't run the action twice. If the promise rejects, the list repaints and stays open with its actions back on, so report your own errors.

## Layout

The list can use the whole overlay height, but it never draws more rows than the terminal has or lines wider than the overlay. Paging keeps the selected item in the middle. Below 12 rows the list switches to a compact layout that keeps the title and search row. The full layout adds the position, such as `3 of 20`, with the move and page keys. The footer lists the actions, wrapping onto a second row or showing only the keys when the labels don't fit.

Custom pickers should call `ctx.ui.custom(factory, OVERLAY_OPTIONS)`, so OMP shows them in the same bottom overlay as Switch Model and leaves the composer untouched underneath.

## Shortcut hint declarations

A plugin can list its shortcuts in a top-level `hkay.shortcutHints` field of its `package.json`, outside the `omp` block that OMP reads, so other plugins can read and show them:

```json
"hkay": { "shortcutHints": [ { "label": "stashes", "settings": ["Browser shortcut"], "priority": 20, "command": "/stash" } ] }
```

- `label` is the short text shown after the keys.
- `settings` names one or more of the plugin's own `omp.settings` string settings. A reader takes each current value from the plugin's settings and falls back to that setting's manifest `default`. `none` means no shortcut.
- `priority` sorts the hints. Lower values come first.
- `command` is optional: a slash command that does the same thing. A reader can show it instead when every key for the hint is blank or `none`.

OhMyStash declares `stash` for Stash shortcut (priority 10) and `stashes` for Browser shortcut (priority 20, command `/stash`).
