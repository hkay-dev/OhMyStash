// extensions/ui.ts as released in 1.10.4 (tag v1.10.4), with only the OMP imports and the calls to the
// removed pi-tui key matcher, Input, and terminal size ported to OMP 19.2.1. The parity tests render its
// selectOption next to the current one, so leave its drawing and key handling unchanged.
import type { ExtensionContext, ExtensionCustomOptions, ExtensionTheme as Theme } from "@oh-my-pi/pi-coding-agent";
import { fuzzyFilter } from "@oh-my-pi/pi-coding-agent/utils/fuzzy";
import { truncate as truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { presetSymbols } from "@oh-my-pi/pi-tui/theme/symbols";
import { keyMatches, readKey, TextField as Input } from "../../extensions/ui";

// OMP's stock bottom overlay, as Switch Model uses it: full width, up to every terminal row, no
// backdrop. Closing it leaves the composer's text, undo history, and caret untouched.
export const OVERLAY_OPTIONS = { overlay: true } as const satisfies ExtensionCustomOptions;

export function extensionIcon(key: string): string {
  return presetSymbols("nerd")[key] ?? "";
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

export function selectOption(
  ctx: ExtensionContext,
  title: string,
  options: string[],
  iconKey?: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((ui, theme, _keybindings, done) => {
    const searchInput = new Input();
    searchInput.prompt = "";
    searchInput.focused = true;
    let filtered = options;
    let selected = 0;
    let pageRows = Math.max(1, Math.min(12, ui.size().rows - 5));
    const glyph = iconKey ? extensionIcon(iconKey) : "";
    const popupTitle = glyph ? `${glyph} ${title}` : title;
    const moveSelection = (index: number) => {
      selected = Math.max(0, Math.min(Math.max(0, filtered.length - 1), index));
      ui.requestRender();
    };
    const keyHint = (key: string, label: string) =>
      `${theme.fg("accent", key)} ${theme.fg("dim", label)}`;
    return {
      handleInput(data: string) {
        const key = readKey(data);
        if (keyMatches(key, "escape") || keyMatches(key, "ctrl+c")) {
          done(undefined);
        } else if (keyMatches(key, "enter")) {
          const option = filtered[selected];
          if (option !== undefined) done(option);
        } else if (keyMatches(key, "up")) {
          moveSelection(selected - 1);
        } else if (keyMatches(key, "down")) {
          moveSelection(selected + 1);
        } else if (keyMatches(key, "home")) {
          moveSelection(0);
        } else if (keyMatches(key, "end")) {
          moveSelection(filtered.length - 1);
        } else if (keyMatches(key, "pageUp")) {
          moveSelection(selected - pageRows);
        } else if (keyMatches(key, "pageDown")) {
          moveSelection(selected + pageRows);
        } else {
          const before = searchInput.getValue();
          searchInput.handleInput(data);
          if (searchInput.getValue() !== before) {
            filtered = fuzzyFilter(options, searchInput.getValue(), (option) => option);
            selected = 0;
          }
          ui.requestRender();
        }
      },
      render(width: number) {
        const renderWidth = Math.max(1, Math.floor(width));
        // The overlay may fill the terminal; OMP drops taller output from the top, title first.
        const terminalRows = Math.max(1, ui.size().rows);
        const contentWidth = Math.max(0, renderWidth - 2);
        const hints = contentWidth >= 64
          ? [keyHint("↑↓", "Move"), keyHint("PgUp/PgDn", "Page"), keyHint("Enter", "Select"), keyHint("Esc", "Close")].join("  ")
          : contentWidth >= 30
            ? [keyHint("↑↓", "Move"), keyHint("Enter", "Select"), keyHint("Esc", "Close")].join("  ")
            : theme.fg("accent", "↑↓ Enter Esc");
        const option = filtered[selected];
        const emptyLabel = options.length === 0 ? "No options available" : "No matching options";
        if (terminalRows < 3 || renderWidth < 4) {
          pageRows = 1;
          return [
            theme.fg("accent", theme.bold(truncateToWidth(option ?? emptyLabel, renderWidth, ""))),
            truncateToWidth(searchInput.getValue() ? `/${searchInput.getValue()}` : hints, renderWidth, ""),
          ].slice(0, terminalRows);
        }
        const frame = createFrame(theme, renderWidth);
        const showSearch = terminalRows >= 5;
        const showHints = terminalRows >= 4;
        const showDivider = terminalRows >= 6;
        const chromeRows = 2 + Number(showSearch) + Number(showHints) + Number(showDivider);
        pageRows = Math.max(1, Math.min(12, terminalRows - chromeRows));
        const listRows = Math.max(1, Math.min(pageRows, filtered.length));
        const firstIndex = Math.min(
          Math.max(0, selected - Math.floor(listRows / 2)),
          Math.max(0, filtered.length - listRows),
        );
        const lines = [frame.top(popupTitle)];
        if (showSearch) {
          const prefix = ` ${theme.fg("accent", extensionIcon("icon.search"))} `;
          const fieldWidth = Math.max(1, contentWidth - visibleWidth(prefix));
          const field = searchInput.render(searchInput.getValue() ? fieldWidth : 1)[0] ?? "";
          const placeholder = searchInput.getValue() ? "" : theme.fg("dim", "Type to search");
          lines.push(frame.row(`${prefix}${field}${placeholder}`));
        }
        if (showDivider) {
          lines.push(frame.divider(searchInput.getValue()
            ? `Matches · ${filtered.length}/${options.length}`
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
        return lines;
      },
    };
  }, OVERLAY_OPTIONS);
}
