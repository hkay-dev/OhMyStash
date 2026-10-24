import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/**
 * The `pi.events` channel that OhMyStash asks for send targets on each time the browser opens.
 * A plugin adds a target by calling `request.add(target)` from its listener, before the listener's
 * first `await`.
 */
export const SEND_TARGETS_CHANNEL = "ohmystash:send-targets";

/** A stash that OhMyStash hands to a send target. */
export interface SentPrompt {
  /** The full prompt text, with pastes expanded. Image markers such as `[Image #1]` stay in it. */
  text: string;
  /** How many images the stash has. They aren't sent. */
  images: number;
}

/** A place other than the composer that the browser can send a stash to. */
export interface SendTarget {
  /** A short label for the browser footer, such as `Notes`. */
  label: string;
  /** Runs after the browser closes, with the main chat's context. */
  send(prompt: SentPrompt, ctx: ExtensionContext): void | Promise<void>;
}

/** What OhMyStash emits on `SEND_TARGETS_CHANNEL`. */
export interface SendTargetsRequest {
  add(target: SendTarget): void;
}

/** Asks every listener on the bus for its targets. */
export function collectSendTargets(events: { emit(channel: string, data: unknown): void } | undefined): SendTarget[] {
  const targets: SendTarget[] = [];
  const request: SendTargetsRequest = {
    add(target) {
      if (typeof target?.label === "string" && target.label.trim() && typeof target.send === "function") {
        targets.push(target);
      }
    },
  };
  events?.emit(SEND_TARGETS_CHANNEL, request);
  return targets;
}
