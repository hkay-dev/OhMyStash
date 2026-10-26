---
title: For plugin authors
feature: for-plugin-authors
covers:
  - extensions/send-targets.ts
  - extensions/native-ui.ts
  - extensions/ui.ts
since: 2026-10-13
description: What OhMyStash offers to other OMP plugins: send targets, native hosts and the shared picker look.
sidebar:
  order: 12
---

If you're writing another OMP plugin, OhMyStash gives you three things. Each one is a separate export of the `@hkay-dev/ohmystash` package, so add OhMyStash as a dependency of your plugin (for example `github:hkay-dev/OhMyStash#v1.15.0`). OMP installs declared dependencies before it loads your extension, so the imports below resolve.

The full references stay in the repo's docs, and the site shows them under Internals. This page is the short version.

## Offer a place to send a stash

Your plugin can be a place the stash browser sends a stash to. Users see it as the [`s` key](send-to-plugins.md) with your label.

Each time the browser opens, OhMyStash emits a request on OMP's shared `pi.events` bus on the `ohmystash:send-targets` channel. Add a target to it with a short `label` and a `send(prompt, ctx)` function. `prompt.text` is the full stash text and `prompt.images` counts the images, which aren't sent. `send` runs after the browser closes, with the main chat's context.

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { SEND_TARGETS_CHANNEL, type SendTargetsRequest } from "@hkay-dev/ohmystash/send-targets";

export default function myPlugin(pi: ExtensionAPI): void {
  let stop: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.agent.kind !== "main" || ctx.mode !== "tui" || stop) return;
    stop = pi.events.on(SEND_TARGETS_CHANNEL, (data) => {
      (data as SendTargetsRequest).add({
        label: "Notes",
        send: async (prompt, ctx) => {
          ctx.ui.notify(`Got ${prompt.text.length} characters`, "info");
        },
      });
    });
  });
  pi.on("session_shutdown", () => {
    stop?.();
    stop = undefined;
  });
}
```

Call `add` before your listener's first `await`. Listen only from the main TUI session, as above, because each subagent loads its own copy of your plugin on the same bus and the browser would get your target once per subagent.

## Host the stash browser natively

If your plugin runs inside an app that can draw its own dialogs, it can draw the stash browser for the user. That's a native UI host. When one is there, `Alt+Shift+S` and `/stash` open the [native stash browser](native-dialogs.md) through it, and without one the usual overlay opens.

You answer a request on the `ohmystash:native-ui` channel by adding a host with a `name` and three functions:

- `list(spec)` shows a searchable list, or updates the open one with the same `id`, and resolves with the user's next event (an action, or a cancel). Reject when you can't show it. If the first list of an opening rejects, OhMyStash opens its overlay instead, without a message.
- `close(id)` closes a list if it's open. It never rejects.
- `edit(spec)` shows a multi-line editor and resolves with the saved text, or `undefined` on cancel.

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { NATIVE_UI_CHANNEL, type NativeUiHost, type NativeUiRequest } from "@hkay-dev/ohmystash/native-ui";

export default function myHost(pi: ExtensionAPI): void {
  let stop: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.agent.kind !== "main" || ctx.mode !== "tui" || stop) return;
    // Only add a host when your app can actually draw here.
    const host: NativeUiHost = {
      name: "My app",
      list: (spec) => myApp.showList(spec),
      close: (id) => myApp.closeList(id),
      edit: (spec) => myApp.editText(spec),
    };
    stop = pi.events.on(NATIVE_UI_CHANNEL, (data) => (data as NativeUiRequest).add(host));
  });
  pi.on("session_shutdown", () => {
    stop?.();
    stop = undefined;
  });
}
```

The list spec carries the items, the footer actions (each with a key such as `cmd+l`, and optional `confirm` text for dialogs like delete) and a preview for the selected item. A bare letter can't be an action key, since letters type into the search. The same two rules about `add` and the main session apply.

## Reuse the picker look

The `@hkay-dev/ohmystash/ui` export has the helpers OhMyStash draws its own pickers with, so your overlays can look the same:

- `OVERLAY_OPTIONS` is the option to pass to `ctx.ui.custom` for OMP's bottom overlay. The composer's draft, caret and undo history stay untouched.
- `createFrame(theme, width)` draws the accent-colored frame with the title in the top border.
- `selectOption(ctx, title, options, iconKey?, settings?)` opens a searchable picker and resolves with the chosen string, or `undefined` when cancelled.
- `showList(ctx, options)` opens a searchable list of any items with footer actions, and `createList(tui, theme, options, done)` gives the same list as a component.
- `formatShortcut(key, { icons })` and `formatShortcutRange(keys, { icons })` turn key ids such as `alt+shift+s` into labels like `Alt+Shift+S`, or Apple keyboard icons.
- `fitToWidth(text, width)` and `extensionIcon(key)` help with row layout and Nerd Font glyphs.

```ts
import { selectOption, showList } from "@hkay-dev/ohmystash/ui";

const color = await selectOption(ctx, "Pick a color", ["Red", "Green", "Blue"], undefined, {
  icons: myShowIconsSetting,
});

const note = await showList(ctx, {
  items: notes,
  title: "Notes",
  search: (note) => note.title,
  renderItem: (note, { width }) => [note.title.slice(0, width)],
  actions: [{ key: "enter", label: "Open", run: (note) => note }],
});
```

Pass your own Show icons setting as `icons`, since the helpers don't read it. A bare printable key always types into the search, so give actions `enter`, `tab` or a ctrl or alt combination. Return a value from an action's `run` to close the list with it, or `undefined` to keep it open.
