import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, ExtensionCustomOptions, Theme } from "@oh-my-pi/pi-coding-agent";
import {
  type Component,
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  type KeyId,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@oh-my-pi/pi-tui";
import { SYMBOL_PRESETS, type SymbolKey } from "@oh-my-pi/pi-tui/theme/symbols";

// OMP's stock bottom overlay, as Switch Model uses it: full width, up to every terminal row, no
// backdrop. Closing it leaves the composer's text, undo history, and caret untouched.
export const OVERLAY_OPTIONS = { overlay: true } as const satisfies ExtensionCustomOptions;

export function extensionIcon(key: string): string {
  const glyph = SYMBOL_PRESETS.nerd[key as SymbolKey];
  return typeof glyph === "string" ? glyph : "";
}

export function fitToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width));
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

export function createFrame(theme: Theme, width: number) {
  const renderWidth = Math.max(1, Math.floor(width));
  const contentWidth = Math.max(0, renderWidth - 2);
  const border = (text: string) => theme.fg("accent", text);
  const heading = (label: string) =>
    theme.fg("accent", theme.bold(truncateToWidth(` ${label} `, contentWidth, "")));
  const line = (left: string, content: string, right: string) =>
    renderWidth === 1 ? border(left) : `${border(left)}${content}${border(right)}`;
  return {
    top(title: string): string {
      const titleText = heading(title);
      return line("┌", `${titleText}${border("─".repeat(Math.max(0, contentWidth - visibleWidth(titleText))))}`, "┐");
    },
    row(text = ""): string {
      return line("│", fitToWidth(text, contentWidth), "│");
    },
    divider(label = ""): string {
      const titleText = label ? heading(label) : "";
      const fill = "─".repeat(Math.max(0, contentWidth - visibleWidth(titleText)));
      return line("├", `${titleText}${label ? theme.fg("muted", fill) : border(fill)}`, "┤");
    },
    bottom(): string {
      return line("└", border("─".repeat(contentWidth)), "┘");
    },
  };
}

/**
 * One entry of the top-level `hkay.shortcutHints` list in a plugin's package.json, outside its `omp`
 * block. Other plugins can read the list to show the plugin's shortcuts.
 */
export interface ShortcutHintDeclaration {
  /** Short text shown after the keys, such as "stash". */
  label: string;
  /** Names of the plugin's own `omp.settings` string settings that hold the keys. */
  settings: string[];
  /** Sort order: lower comes first. */
  priority: number;
}

// Key labels after formatKey in @oh-my-pi/pi-tui 18.10.3 src/key-hint-format.ts, which compiled OMP
// doesn't serve to plugins. Icons always come from the Nerd Font preset's Apple keyboard icons, whatever
// preset the theme uses, because the Unicode keycaps (⌥⇧S) are hard to read at terminal font sizes.
// Modifiers are in macOS menu order (⌃⌥⇧⌘), which is how they render whatever order a key lists them in.
type KeyLabel = readonly [icon: string, text: string];
const nerd = SYMBOL_PRESETS.nerd;
const MODIFIER_LABELS: Record<string, KeyLabel> = {
  ctrl: [nerd["key.ctrlMac"], "Ctrl"],
  alt: [nerd["key.altMac"], "Alt"],
  shift: [nerd["key.shift"], "Shift"],
  super: [nerd["key.superMac"], "Cmd"],
};
const KEY_LABELS: Record<string, KeyLabel> = {
  esc: [nerd["key.esc"], "Esc"],
  escape: [nerd["key.esc"], "Esc"],
  enter: [nerd["key.enter"], "Enter"],
  return: [nerd["key.enter"], "Enter"],
  tab: [nerd["key.tab"], "Tab"],
  backspace: [nerd["key.backspace"], "Backspace"],
  delete: [nerd["key.delete"], "Delete"],
  space: [nerd["key.space"], "Space"],
  up: ["↑", "↑"],
  down: ["↓", "↓"],
  left: ["←", "←"],
  right: ["→", "→"],
  home: ["Home", "Home"],
  end: ["End", "End"],
  pageup: ["PgUp", "PgUp"],
  pagedown: ["PgDn", "PgDn"],
  insert: ["Ins", "Ins"],
};

type Shortcut = { modifiers: KeyLabel[]; base: string; chord: boolean };

function parseShortcut(key: string): Shortcut | undefined {
  const id = key.trim().toLowerCase();
  if (!id || id === "none") return undefined;
  // A trailing `+` is the plus key itself (`+`, `ctrl++`), not a separator.
  const parts = id.endsWith("+") ? [...id.slice(0, -1).split("+").slice(0, -1), "+"] : id.split("+");
  const base = parts.pop() ?? "";
  const modifiers = Object.entries(MODIFIER_LABELS).filter(([name]) => parts.includes(name)).map(([, label]) => label);
  return { modifiers, base, chord: parts.length > 0 };
}

function shortcutLabel({ modifiers, base, chord }: Shortcut, icons: boolean): string {
  const which = icons ? 0 : 1;
  // Own keys only, so a key named like an Object.prototype member, such as `constructor`, isn't a label.
  const named = Object.hasOwn(MODIFIER_LABELS, base) ? MODIFIER_LABELS[base]
    : Object.hasOwn(KEY_LABELS, base) ? KEY_LABELS[base]
    : undefined;
  // A bare letter stays lowercase, since Q would read as Shift+Q; in a chord it is capitalized.
  const last = named ? named[which] : base.length === 1 && !chord ? base : base.charAt(0).toUpperCase() + base.slice(1);
  const text = [...modifiers.map((label) => label[which]), last].join(icons ? " " : "+");
  return stripVTControlCharacters(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
}

/**
 * Formats an OMP key id such as `alt+shift+s` for display. By default each key is a Nerd Font Apple keyboard
 * icon, separated by spaces (`⌥ ⇧ S`); `icons: false` gives plain text such as `Alt+Shift+S`. Returns "" for
 * a blank key or `none`.
 */
export function formatShortcut(key: string, options?: { icons?: boolean }): string {
  const shortcut = parseShortcut(key);
  return shortcut ? shortcutLabel(shortcut, options?.icons ?? true) : "";
}

/**
 * Formats several keys, skipping blank and `none` keys. Three or more keys with the same modifiers and
 * consecutive digits in order collapse into one range, such as `Alt+1-5`; other keys are joined with spaces.
 */
export function formatShortcutRange(keys: readonly string[], options?: { icons?: boolean }): string {
  const icons = options?.icons ?? true;
  const shortcuts = keys.map(parseShortcut).filter((shortcut) => shortcut !== undefined);
  const first = shortcuts[0];
  const last = shortcuts.at(-1);
  const range = first !== undefined && shortcuts.length >= 3 && shortcuts.every((shortcut, index) =>
    /^\d$/.test(shortcut.base) &&
    Number(shortcut.base) === Number(first.base) + index &&
    shortcut.modifiers.length === first.modifiers.length &&
    shortcut.modifiers.every((modifier, position) => modifier === first.modifiers[position]));
  if (range && last) return `${shortcutLabel(first, icons)}-${last.base}`;
  return shortcuts.map((shortcut) => shortcutLabel(shortcut, icons)).filter(Boolean).join(" ");
}

/** What `renderItem` gets for each item it draws. */
export interface ListRowContext {
  /** Cells available for each row after the selection marker. Longer rows are clipped. */
  width: number;
  /** True for the selected item. */
  selected: boolean;
  theme: Theme;
  /** True in the short-terminal layout, which shows one row per item. */
  compact: boolean;
}

/** The list as a title or empty label sees it. */
export interface ListState<T> {
  /** The search text. */
  query: string;
  /** The items that match the search, in display order. */
  matches: readonly T[];
  /** The number of items before the search. */
  total: number;
  /** The selected match, if any. */
  selected: T | undefined;
}

/** A footer action of a list. */
export interface ListAction<T, R> {
  /** OMP key id, such as `enter`, `ctrl+o`, or `tab`. The primary action uses `enter`. */
  key: string;
  /** Footer label, such as `Open`. */
  label: string;
  /**
   * Runs with the selected match, or undefined when nothing matches. Return a result to close the list with
   * it, or undefined to keep the list open and repaint it. A promise is awaited; if it rejects, the list
   * stays open, so report your own errors.
   */
  run(item: T | undefined): R | undefined | void | PromiseLike<R | undefined | void>;
}

/** Options for `showList` and `createList`. */
export interface ListOptions<T, R> {
  /** The items, or a function that returns the current items of a list that changes while it is open. */
  items: readonly T[] | (() => readonly T[]);
  /** The frame title, or a function of the list state, for example to show match counts. */
  title: string | ((state: ListState<T>) => string);
  /** Draws an item as one row, or as two rows for a two-line item. Return as many rows for every item. */
  renderItem(item: T, row: ListRowContext): string[];
  /** Search text for an item: every word of the search must appear in it, ignoring case. Defaults to `String(item)`. */
  search?(item: T): string;
  /** Replaces the word search: returns the items to show for a search, in display order. */
  filter?(items: readonly T[], query: string): readonly T[];
  /** Identifies an item across changes to the items, so the selection stays on it. Defaults to the item itself. */
  id?(item: T): unknown;
  /** The item to select when the list opens. */
  selected?: T;
  /** Shown when nothing matches. Defaults to `No items`, or `No matching items` when the items are filtered out. */
  emptyLabel?: string | ((state: ListState<T>) => string);
  /** Label before the search field. Defaults to `Search`. */
  prompt?: string;
  /** Dim text in the empty search field. Defaults to `Type to search`. */
  placeholder?: string;
  /** Footer actions in display order. Esc always closes the list and is listed last. */
  actions?: readonly ListAction<T, R>[];
  /** Another key that closes the list, such as the shortcut that opened it. Blank or `none` adds no key. */
  toggleKey?: string;
}

/** The list as a component, for a plugin that shows it inside its own overlay component. */
export interface ListComponent<T> extends Component, Focusable {
  handleInput(data: string): void;
  invalidate(): void;
  /** Selects the listed item with the same `id`, if there is one. */
  select(item: T): void;
}

interface ListView<T> extends ListState<T> {
  theme: Theme;
  input: Input;
  /** Terminal rows, at least 1. */
  rows: number;
  /** The selected match's index, 0 when nothing matches. */
  index: number;
}

type ListLayout<T> = (list: ListView<T>, width: number) => { lines: string[]; pageSize: number };

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

// Search, selection, keys, and actions, shared by every list. The layout draws the list and reports how
// many items PgUp and PgDn move.
function listComponent<T, R>(
  tui: TUI,
  theme: Theme,
  options: ListOptions<T, R>,
  done: (result: R | undefined) => void,
  layout: ListLayout<T>,
  pageSize: number,
  terminalCursor: boolean,
): ListComponent<T> {
  const input = new Input();
  input.prompt = "";
  input.focused = true;
  const source = options.items;
  const id = (item: T): unknown => (options.id ? options.id(item) : item);
  const matchWords = (items: readonly T[], query: string): readonly T[] => {
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return items;
    return items.filter((item) => {
      const text = (options.search ? options.search(item) : String(item)).toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    });
  };
  const toggle = options.toggleKey?.trim() ?? "";
  const toggleKey = toggle && toggle.toLowerCase() !== "none" ? (toggle as KeyId) : undefined;
  let filtered: { items: readonly T[]; query: string; matches: readonly T[] } | undefined;
  let index = 0;
  // The selected item's id, so the selection stays on that item when the items change.
  let anchored = options.selected !== undefined;
  let anchor = anchored ? id(options.selected as T) : undefined;
  const view = (): ListView<T> => {
    const items = typeof source === "function" ? source() : source;
    const query = input.getValue();
    // A fixed list is filtered once per search; a function's items may change between calls.
    if (typeof source === "function" || filtered?.items !== items || filtered.query !== query) {
      filtered = { items, query, matches: options.filter ? options.filter(items, query) : matchWords(items, query) };
    }
    const { matches } = filtered;
    if (!(anchored && index < matches.length && Object.is(id(matches[index] as T), anchor))) {
      index = anchored ? Math.max(0, matches.findIndex((item) => Object.is(id(item), anchor))) : 0;
    }
    const selected = matches[index];
    anchored = index < matches.length;
    anchor = anchored ? id(selected as T) : undefined;
    return { theme, input, rows: Math.max(1, tui.terminal.rows), query, matches, total: items.length, selected, index };
  };
  const settle = (result: unknown): void => {
    if (isPromiseLike(result)) {
      result.then(settle, () => tui.requestRender());
    } else if (result === undefined) {
      tui.requestRender();
    } else {
      done(result as R);
    }
  };
  const component: ListComponent<T> = {
    get focused() {
      return input.focused;
    },
    set focused(value: boolean) {
      input.focused = value;
    },
    invalidate() {
      input.invalidate();
    },
    select(item: T) {
      anchored = true;
      anchor = id(item);
      index = 0;
      tui.requestRender();
    },
    handleInput(data: string) {
      if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c")) ||
        (toggleKey !== undefined && matchesKey(data, toggleKey))
      ) {
        done(undefined);
        return;
      }
      const action = options.actions?.find((candidate) => matchesKey(data, candidate.key as KeyId));
      const list = view();
      if (action) {
        settle(action.run(list.selected));
        return;
      }
      const target = matchesKey(data, Key.up) ? list.index - 1
        : matchesKey(data, Key.down) ? list.index + 1
        : matchesKey(data, Key.home) ? 0
        : matchesKey(data, Key.end) ? list.matches.length - 1
        : matchesKey(data, Key.pageUp) ? list.index - pageSize
        : matchesKey(data, Key.pageDown) ? list.index + pageSize
        : undefined;
      if (target === undefined) {
        const before = input.getValue();
        input.handleInput(data);
        if (input.getValue() !== before) {
          index = 0;
          anchored = false;
        }
      } else {
        index = Math.max(0, Math.min(list.matches.length - 1, target));
        anchored = index < list.matches.length;
        anchor = anchored ? id(list.matches[index] as T) : undefined;
      }
      tui.requestRender();
    },
    render(width: number) {
      const drawn = layout(view(), width);
      pageSize = drawn.pageSize;
      return drawn.lines;
    },
  };
  if (terminalCursor) component.setUseTerminalCursor = (value: boolean) => input.setUseTerminalCursor(value);
  return component;
}

function drawList<T, R>(options: ListOptions<T, R>, list: ListView<T>, width: number) {
  const { theme, input, query, matches, index } = list;
  const renderWidth = Math.max(1, Math.floor(width));
  // The overlay may fill the terminal; OMP drops taller output from the top, title first.
  const height = list.rows;
  const framed = renderWidth >= 8 && height >= 5;
  const compact = !framed || height < 12;
  const inner = Math.max(1, renderWidth - (framed ? 4 : 0));
  const frame = createFrame(theme, renderWidth);
  const accent = (text: string) => theme.fg("accent", text);
  // One row of content, clipped and padded to the inner width, highlighted when selected, then framed.
  const fit = (text: string, selected = false) => {
    const padded = fitToWidth(text, inner);
    const content = selected ? theme.bg("selectedBg", padded) : padded;
    return framed ? frame.row(` ${content} `) : content;
  };
  const state: ListState<T> = { query, matches, total: list.total, selected: list.selected };
  const title = typeof options.title === "function" ? options.title(state) : options.title;
  const emptyLabel = typeof options.emptyLabel === "function"
    ? options.emptyLabel(state)
    : options.emptyLabel ?? (state.total ? "No matching items" : "No items");

  const label = options.prompt ?? "Search";
  const labelText = label ? `${label}  ` : "";
  // A narrow row gives its room to the search field instead of the label.
  const labelWidth = labelText && inner - visibleWidth(labelText) >= 10 ? visibleWidth(labelText) : 0;
  const field = input.render(query ? Math.max(1, inner - labelWidth) : 1)[0] ?? "";
  const placeholder = query ? "" : theme.fg("dim", options.placeholder ?? "Type to search");
  const search = `${labelWidth ? accent(labelText) : ""}${field}${placeholder}`;

  const hints = [
    ...(options.actions ?? []).map((action) => [formatShortcut(action.key, { icons: false }), action.label] as const),
    ["Esc", "Close"] as const,
  ];
  // Whole hints, wrapped onto at most maxRows rows, or just the keys when they don't fit.
  const footer = (maxRows: number): string[] => {
    const rows: string[] = [];
    for (const [key, text] of hints) {
      const hint = `${accent(key)} ${text}`;
      const last = rows.at(-1);
      if (last !== undefined && visibleWidth(`${last}  ${hint}`) <= inner) rows[rows.length - 1] = `${last}  ${hint}`;
      else rows.push(hint);
    }
    return rows.length <= maxRows && rows.every((text) => visibleWidth(text) <= inner)
      ? rows
      : [hints.map(([key]) => accent(key)).join("  ")];
  };

  const drawnItems = new Map<number, string[]>();
  const drawItem = (i: number) => {
    let drawn = drawnItems.get(i);
    if (!drawn) {
      drawn = options.renderItem(matches[i] as T, { width: Math.max(0, inner - 2), selected: i === index, theme, compact });
      drawnItems.set(i, drawn);
    }
    return drawn;
  };
  const itemRows = (i: number, count: number) => Array.from({ length: count }, (_, line) =>
    fit(`${line === 0 && i === index ? accent("› ") : "  "}${drawItem(i)[line] ?? ""}`, i === index));

  if (!framed) {
    const lines = [
      fit(accent(theme.bold(title))),
      fit(search),
      matches.length ? (itemRows(index, 1)[0] ?? "") : fit(theme.fg("muted", emptyLabel)),
      fit(footer(1)[0] ?? ""),
    ];
    return { lines: lines.slice(0, height), pageSize: 1 };
  }

  const footerRows = footer(compact ? 1 : 2);
  // Every item takes as many rows as the first match.
  const perItem = compact || matches.length === 0 ? 1 : Math.min(2, Math.max(1, drawItem(0).length));
  const chrome = (compact ? 3 : 6) + footerRows.length;
  const pageSize = Math.max(1, Math.floor((height - chrome) / perItem));
  const lines = [frame.top(title), fit(search)];
  if (!compact) lines.push(frame.divider());
  if (matches.length === 0) {
    lines.push(fit(theme.fg("muted", emptyLabel)));
  } else {
    // Paging keeps the selected item in the middle, except near either end of the list.
    const start = Math.max(0, Math.min(index - Math.floor(pageSize / 2), matches.length - pageSize));
    for (let i = start; i < Math.min(matches.length, start + pageSize); i += 1) lines.push(...itemRows(i, perItem));
    if (!compact) {
      const move = `${theme.fg("muted", `${index + 1} of ${matches.length} · `)}${accent("↑↓")} Move`;
      const status = [`${move} · ${accent("PgUp/PgDn")} Page`, move]
        .find((text) => visibleWidth(text) <= inner) ?? theme.fg("muted", `${index + 1} of ${matches.length}`);
      lines.push(fit(status));
    }
  }
  if (!compact) lines.push(frame.divider());
  lines.push(...footerRows.map((text) => fit(text)), frame.bottom());
  return { lines, pageSize };
}

/**
 * The searchable list as a component, for a plugin that shows it inside its own overlay component. `done`
 * receives an action's result, or undefined when Esc, Ctrl+C, or the toggle key closes the list.
 */
export function createList<T, R>(
  tui: TUI,
  theme: Theme,
  options: ListOptions<T, R>,
  done: (result: R | undefined) => void,
): ListComponent<T> {
  return listComponent(tui, theme, options, done, (list, width) => drawList(options, list, width), 1, true);
}

/**
 * Opens a searchable list in OMP's stock bottom overlay. Resolves to the result of the footer action that
 * closed it, or undefined when Esc, Ctrl+C, or the toggle key closes it.
 */
export function showList<T, R>(ctx: ExtensionContext, options: ListOptions<T, R>): Promise<R | undefined> {
  return ctx.ui.custom<R | undefined>(
    (tui, theme, _keybindings, done) => createList(tui, theme, options, done),
    OVERLAY_OPTIONS,
  );
}

// selectOption's own drawing, unchanged since 1.10.4 so its pickers keep their look.
function drawOptions(title: string, list: ListView<string>, width: number) {
  const { theme, input: searchInput, matches: filtered, index: selected } = list;
  const renderWidth = Math.max(1, Math.floor(width));
  // The overlay may fill the terminal; OMP drops taller output from the top, title first.
  const terminalRows = list.rows;
  const contentWidth = Math.max(0, renderWidth - 2);
  const keyHint = (key: string, label: string) =>
    `${theme.fg("accent", key)} ${theme.fg("dim", label)}`;
  const hints = contentWidth >= 64
    ? [keyHint("↑↓", "Move"), keyHint("PgUp/PgDn", "Page"), keyHint("Enter", "Select"), keyHint("Esc", "Close")].join("  ")
    : contentWidth >= 30
      ? [keyHint("↑↓", "Move"), keyHint("Enter", "Select"), keyHint("Esc", "Close")].join("  ")
      : theme.fg("accent", "↑↓ Enter Esc");
  const option = filtered[selected];
  const emptyLabel = list.total === 0 ? "No options available" : "No matching options";
  if (terminalRows < 3 || renderWidth < 4) {
    const lines = [
      theme.fg("accent", theme.bold(truncateToWidth(option ?? emptyLabel, renderWidth, ""))),
      truncateToWidth(searchInput.getValue() ? `/${searchInput.getValue()}` : hints, renderWidth, ""),
    ].slice(0, terminalRows);
    return { lines, pageSize: 1 };
  }
  const frame = createFrame(theme, renderWidth);
  const showSearch = terminalRows >= 5;
  const showHints = terminalRows >= 4;
  const showDivider = terminalRows >= 6;
  const chromeRows = 2 + Number(showSearch) + Number(showHints) + Number(showDivider);
  const pageRows = Math.max(1, Math.min(12, terminalRows - chromeRows));
  const listRows = Math.max(1, Math.min(pageRows, filtered.length));
  const firstIndex = Math.min(
    Math.max(0, selected - Math.floor(listRows / 2)),
    Math.max(0, filtered.length - listRows),
  );
  const lines = [frame.top(title)];
  if (showSearch) {
    const prefix = ` ${theme.fg("accent", extensionIcon("icon.search"))} `;
    const fieldWidth = Math.max(1, contentWidth - visibleWidth(prefix));
    const field = searchInput.render(searchInput.getValue() ? fieldWidth : 1)[0] ?? "";
    const placeholder = searchInput.getValue() ? "" : theme.fg("dim", "Type to search");
    lines.push(frame.row(`${prefix}${field}${placeholder}`));
  }
  if (showDivider) {
    lines.push(frame.divider(searchInput.getValue()
      ? `Matches · ${filtered.length}/${list.total}`
      : `Options · ${filtered.length}`));
  }
  for (let row = 0; row < listRows; row += 1) {
    const index = firstIndex + row;
    const label = filtered[index];
    if (label === undefined) {
      lines.push(frame.row(` ${theme.fg("muted", emptyLabel)}`));
    } else {
      const isSelected = index === selected;
      const cursor = isSelected ? theme.fg("accent", ">") : " ";
      const text = isSelected ? theme.fg("accent", theme.bold(label)) : theme.fg("text", label);
      lines.push(frame.row(` ${cursor} ${text}`));
    }
  }
  if (showHints) lines.push(frame.row(` ${hints}`));
  lines.push(frame.bottom());
  return { lines, pageSize: pageRows };
}

export function selectOption(
  ctx: ExtensionContext,
  title: string,
  options: string[],
  iconKey?: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const glyph = iconKey ? extensionIcon(iconKey) : "";
    const popupTitle = glyph ? `${glyph} ${title}` : title;
    const list: ListOptions<string, string> = {
      items: options,
      title: popupTitle,
      filter: (items, query) => fuzzyFilter(items as string[], query, (option) => option),
      renderItem: (option) => [option],
      actions: [{ key: "enter", label: "Select", run: (option) => option }],
    };
    const pageSize = Math.max(1, Math.min(12, tui.terminal.rows - 5));
    return listComponent(tui, theme, list, done, (view, width) => drawOptions(popupTitle, view, width), pageSize, false);
  }, OVERLAY_OPTIONS);
}
