# Native UI hosts

Another OMP plugin can draw OhMyStash's stash browser as a native dialog, for example when OMP runs inside a terminal app that can draw its own windows. That plugin is a native UI host. When one is there, `Alt+Shift+S` and `/stash` open the browser through it instead of the TUI overlay, and every browser action runs the same storage steps and shows the same messages as in the TUI. Without a host, nothing changes.

Each time the browser opens, OhMyStash emits a request on OMP's shared `pi.events` bus and takes the first host that adds itself. The types and the channel are exported at `@hkay-dev/ohmystash/native-ui`, so add OhMyStash as a package dependency of your plugin, as for [send targets](send-targets.md).

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

- Call `add` before your listener's first `await`. OhMyStash reads the host as soon as the emit returns.
- Listen only from the main TUI session, as above, for the same reason as with send targets: subagents load their own copy of your plugin on the same bus.

## The host

```ts
interface NativeUiHost {
  readonly name: string;
  list(spec: NativeListSpec): Promise<NativeListEvent>;
  close(id: string): Promise<void>;
  edit(spec: NativeEditSpec): Promise<string | undefined>;
}
```

- `list` shows a searchable list, or updates the open one with the same `id`, and resolves with the user's next event: `{ type: "action", action, item?, query, scope? }` or `{ type: "cancel", query, scope? }`. It rejects when the host can't show it. If the first `list` of an opening rejects, OhMyStash opens its TUI browser instead, without a message. A later rejection shows the usual `OMS failed:` message and ends the browser.
- `close(id)` closes that list if it's open. It never rejects. OhMyStash calls it when the browser ends for any reason.
- `edit` shows a multi-line text editor and resolves with the text on save, or `undefined` on cancel. OhMyStash uses it for Edit.

The list spec has an `id`, `title`, optional `icon`, `placeholder`, `query`, `selected` item id, `scopes` (a segmented switch) with the `scope` showing, `items`, `actions`, an `empty` text and a `preview` flag. Each item has an `id`, `title`, optional `subtitle`, `accessory` (a short trailing text such as an age), `icon`, `marks` (small symbols after the subtitle), `scopes` it shows in, extra `search` text, `tags`, and a `preview` with optional `meta` and the `text`. Icons and marks are SF Symbol names. The full types, with comments, are in `extensions/native-ui.ts`.

## Actions and keys

Each action has an `id`, a `label` and a `key`, plus these optional fields:

- `item`: needs a selected item. Defaults to true.
- `when` and `unless`: the action shows only when the selected item has, or doesn't have, that tag.
- `close`: the dialog closes as soon as the action runs.
- `confirm`: `{ title, message?, button, destructive? }`. The host asks first and only sends the event when the user agrees. In `message`, `{title}` is the selected item's title and `{count}` the number of items in the scope.

A key is the modifiers `cmd`, `ctrl`, `alt` and `shift` joined with `+`, then a key name, such as `enter`, `shift+enter`, `cmd+l` or `cmd+shift+backspace`. A bare letter can't be an action key, since letters type into the search. Up, down, Escape and Tab belong to the dialog: move, clear the search then close, and cycle scopes.

The stash browser uses:

| Key | Action |
|---|---|
| `enter` | Restore |
| `shift+enter` | Pop |
| `alt+enter` | Draft to queue |
| `cmd+shift+enter` | Submit queue (queue stashes) |
| `cmd+enter` | Send (when a send target exists) |
| `cmd+e` | Edit |
| `cmd+l` | Lock or Unlock |
| `cmd+backspace` | Delete (unlocked stashes, confirmed) |
| `cmd+shift+backspace` | Delete unlocked in this scope (confirmed) |

## Pending lists

After an action without `close`, the dialog stays up but ignores input until the plugin calls `list` again with the same id, `edit`, or `close`. OhMyStash always does one of these right after the action runs. A host may close a list on its own when nothing comes for a few seconds.

An `edit` while a list is up shows the editor in the list's place, and the next `list` with that id brings the list back. With more than one send target, Send opens a second list, `ohmystash.send`, to pick one, and OhMyStash closes it after the pick.
