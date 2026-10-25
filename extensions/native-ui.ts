/**
 * The `pi.events` channel that OhMyStash asks for a native UI host on each time the browser opens.
 * A host is another plugin that can draw dialogs natively, for example in a terminal app that can
 * draw its own windows. It adds itself by calling `request.add(host)` from its listener, before the
 * listener's first `await`. Without a host, OhMyStash uses its own TUI.
 */
export const NATIVE_UI_CHANNEL = "ohmystash:native-ui";

/** What OhMyStash emits on `NATIVE_UI_CHANNEL`. */
export interface NativeUiRequest {
  /** Call before your listener's first `await`. */
  add(host: NativeUiHost): void;
}

/** Something that draws dialogs natively in place of the TUI. */
export interface NativeUiHost {
  /** The app that draws the dialogs, for messages. */
  readonly name: string;
  /**
   * Shows the list, or updates the open one with the same id, and resolves with the user's next
   * event. Rejects when the host can't show it; the caller falls back to its TUI.
   */
  list(spec: NativeListSpec): Promise<NativeListEvent>;
  /** Closes list `id` if it's open. Never rejects. */
  close(id: string): Promise<void>;
  /** A multi-line text editor. Resolves with the text on save, undefined on cancel. Rejects like list. */
  edit(spec: NativeEditSpec): Promise<string | undefined>;
}

export interface NativeListSpec {
  /** Stable per dialog, such as `ohmystash.browser`. The same id updates an open list. */
  id: string;
  /** Shown above the list. */
  title: string;
  /** An SF Symbol name for the title. */
  icon?: string;
  /** The search field's hint. */
  placeholder?: string;
  /** The search text to start with. */
  query?: string;
  /** The item id to select. */
  selected?: string;
  /** A segmented switch; Tab cycles it. */
  scopes?: { id: string; label: string }[];
  /** The scope showing. */
  scope?: string;
  items: NativeListItem[];
  actions: NativeListAction[];
  /** Shown when the scope has no items. */
  empty?: string;
  /** A preview column for the selected item. */
  preview?: boolean;
}

export interface NativeListItem {
  id: string;
  title: string;
  subtitle?: string;
  /** Short trailing text, such as an age. */
  accessory?: string;
  /** An SF Symbol at the leading edge. */
  icon?: string;
  /** SF Symbols after the subtitle, such as `lock.fill` or `paperclip`. */
  marks?: string[];
  /** The scopes the item shows in; absent means all. */
  scopes?: string[];
  /** More text the search matches. */
  search?: string;
  /** What actions' `when` and `unless` test. */
  tags?: string[];
  preview?: { meta?: string; text: string; mono?: boolean };
}

export interface NativeListAction {
  id: string;
  label: string;
  /**
   * Modifiers (`cmd`, `ctrl`, `alt`, `shift`) joined with `+`, then a key name, such as `enter`,
   * `shift+enter`, `cmd+l` or `cmd+shift+backspace`. A bare letter can't be an action key, since
   * letters type into the search.
   */
  key: string;
  /** Needs a selected item. Defaults to true. */
  item?: boolean;
  /** Shows only when the selected item has this tag. */
  when?: string;
  /** Hides when the selected item has this tag. */
  unless?: string;
  /** The dialog closes as soon as the action runs. */
  close?: boolean;
  /** Asks first. In `message`, `{title}` is the selected item's title and `{count}` the scope's item count. */
  confirm?: { title: string; message?: string; button: string; destructive?: boolean };
}

export type NativeListEvent =
  | { type: "action"; action: string; item?: string; query: string; scope?: string }
  | { type: "cancel"; query: string; scope?: string };

export interface NativeEditSpec {
  id: string;
  title: string;
  text: string;
  placeholder?: string;
  /** The save button's label. Defaults to `Save`. */
  save?: string;
}

/** Asks every listener on the bus for a host and returns the first one added. */
export function collectNativeHost(
  events: { emit(channel: string, data: unknown): void } | undefined,
): NativeUiHost | undefined {
  let found: NativeUiHost | undefined;
  const request: NativeUiRequest = {
    add(host) {
      if (
        !found &&
        typeof host?.list === "function" &&
        typeof host.close === "function" &&
        typeof host.edit === "function"
      ) {
        found = host;
      }
    },
  };
  events?.emit(NATIVE_UI_CHANNEL, request);
  return found;
}
