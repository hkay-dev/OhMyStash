# Send targets

Another OMP plugin can add a place that the stash browser sends a stash to. The browser shows `s` with the target's label, and pressing it closes the browser and calls the target with the stash's text. OhMyStash doesn't change the composer for this, and it keeps the stash, the same as after a restore.

Each time the browser opens, OhMyStash emits a request on OMP's shared `pi.events` bus. A plugin answers by adding a target to that request. The types and the channel are exported at `@hkay-dev/ohmystash/send-targets`, so add OhMyStash as a package dependency of your plugin, as for the [shared picker UI](ui.md).

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

- Call `add` before your listener's first `await`. OhMyStash reads the targets as soon as the emit returns.
- OMP shares one bus with its subagents, and each subagent loads its own copy of your plugin. Listen only from the main TUI session, as above, or the browser gets a copy of your target for every subagent.
- `label` is short text for the browser footer. With more than one target, the footer shows `s Send`, and `s` opens a picker of the labels.
- `send(prompt, ctx)` runs after the browser closes, so it can open its own overlay. `ctx` is the main chat's context. `prompt.text` is the full prompt with pastes expanded, and image markers such as `[Image #1]` stay in it. `prompt.images` counts the stash's images, which aren't sent. If `send` throws, OhMyStash shows the error.
