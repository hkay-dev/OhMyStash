import { expect, test } from "bun:test";
import type { ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import { type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { SYMBOL_PRESETS } from "@oh-my-pi/pi-tui/theme/symbols";
import {
  createList,
  formatShortcut,
  formatShortcutRange,
  type ListComponent,
  type ListOptions,
  OVERLAY_OPTIONS,
  selectOption,
  type SelectOptionSettings,
  type ShortcutHintDeclaration,
  showList,
} from "../extensions/ui";
import { selectOption as selectOption1104 } from "./fixtures/ui-1.10.4";

const nerd = SYMBOL_PRESETS.nerd;
const CTRL = nerd["key.ctrlMac"];
const ALT = nerd["key.altMac"];
const SHIFT = nerd["key.shift"];
const CMD = nerd["key.superMac"];
const SEARCH = nerd["icon.search"];
const KEY = {
  up: "\u001b[A",
  down: "\u001b[B",
  left: "\u001b[D",
  home: "\u001b[H",
  end: "\u001b[F",
  pageUp: "\u001b[5~",
  pageDown: "\u001b[6~",
  enter: "\r",
  escape: "\u001b",
  backspace: "\u007f",
  tab: "\t",
  altN: "\u001bn",
  ctrlC: "\u0003",
  ctrlO: "\u000f",
  ctrlR: "\u0012",
  ctrlU: "\u0015",
  ctrlX: "\u0018",
};
const PLAIN_THEME = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
// Real SGR codes, which take no cells, so styling is compared without changing any widths.
const COLOR_CODES: Record<string, number> = { accent: 33, muted: 245, dim: 240, text: 252, selectedBg: 236 };
const ANSI_THEME = {
  fg: (color: string, text: string) => `\u001b[38;5;${COLOR_CODES[color] ?? 1}m${text}\u001b[39m`,
  bg: (color: string, text: string) => `\u001b[48;5;${COLOR_CODES[color] ?? 1}m${text}\u001b[49m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
} as unknown as Theme;

type FakeTui = { terminal: { rows: number }; renders: number; requestRender(): void };
type Outcome<R> = { closed: boolean; value?: R };
type File = { name: string; folder: string };

function fakeTui(rows: number): FakeTui {
  return {
    terminal: { rows },
    renders: 0,
    requestRender() {
      this.renders += 1;
    },
  };
}

function files(count: number): File[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `file-${String(index).padStart(3, "0")}.ts`,
    folder: `src/part-${index % 7}`,
  }));
}

const oneRow = (file: File) => [file.name];
const twoRows = (file: File) => [file.name, `  ${file.folder}`];
const wideRow = (file: File) => [`${nerd["icon.file"]} 漢字 ${file.name} ${file.folder}`];

function fileOptions(
  items: readonly File[] | (() => readonly File[]),
  extra: Partial<ListOptions<File, string>> = {},
): ListOptions<File, string> {
  return {
    items,
    title: ({ query, matches, total }) => (query ? `Files · ${matches.length} of ${total}` : `Files · ${total}`),
    renderItem: oneRow,
    search: (file) => `${file.name} ${file.folder}`,
    placeholder: "File or folder",
    actions: [{ key: "enter", label: "Open", run: (file) => file?.name }],
    ...extra,
  };
}

// Opens the list through showList with a stand-in for ctx.ui.custom, as OMP mounts it.
function openList<T, R>(options: ListOptions<T, R>, rows = 24, theme = PLAIN_THEME) {
  const tui = fakeTui(rows);
  const outcome: Outcome<R> = { closed: false };
  let list: ListComponent<T> | undefined;
  const ctx = {
    ui: {
      custom(
        factory: (tui: FakeTui, theme: Theme, keybindings: unknown, done: (value: R | undefined) => void) => ListComponent<T>,
        mountOptions: unknown,
      ) {
        expect(mountOptions).toBe(OVERLAY_OPTIONS);
        const { promise, resolve } = Promise.withResolvers<R | undefined>();
        list = factory(tui, theme, undefined, resolve);
        return promise;
      },
    },
  } as unknown as ExtensionContext;
  const result = showList(ctx, options);
  void result.then((value) => Object.assign(outcome, { closed: true, value }));
  if (!list) throw new Error("The list was not presented");
  return { list, tui, result, outcome };
}

function press(component: { handleInput?(data: string): void }, keys: Iterable<string>): void {
  for (const key of keys) component.handleInput?.(key);
}

// Item rows of a framed list, in order, and the index of the selected one among them.
function itemRows(lines: readonly string[]) {
  const rows = lines.filter((line) => line.includes("file-") || line.includes("src/part-"));
  return { rows, selected: rows.findIndex((line) => line.includes("› ")) };
}

test("formats shortcuts as Nerd Font keyboard icons in macOS menu order", () => {
  expect(formatShortcut("alt+s")).toBe(`${ALT} S`);
  expect(formatShortcut("alt+shift+s")).toBe(`${ALT} ${SHIFT} S`);
  expect(formatShortcut("shift+alt+s")).toBe(`${ALT} ${SHIFT} S`);
  expect(formatShortcut("super+shift+alt+ctrl+s")).toBe(`${CTRL} ${ALT} ${SHIFT} ${CMD} S`);
  expect(formatShortcut("Ctrl+Alt+Shift+Super+S", { icons: true })).toBe(`${CTRL} ${ALT} ${SHIFT} ${CMD} S`);
  expect(formatShortcut("alt+1")).toBe(`${ALT} 1`);
  expect(formatShortcut("shift")).toBe(SHIFT);
  // Named keys.
  expect(["enter", "return", "esc", "escape", "tab", "backspace", "delete", "space"].map((key) => formatShortcut(key)))
    .toEqual([
      nerd["key.enter"], nerd["key.enter"], nerd["key.esc"], nerd["key.esc"],
      nerd["key.tab"], nerd["key.backspace"], nerd["key.delete"], nerd["key.space"],
    ]);
  expect(formatShortcut("shift+tab")).toBe(`${SHIFT} ${nerd["key.tab"]}`);
  // Arrows stay Unicode arrows.
  expect(["up", "down", "left", "right"].map((key) => formatShortcut(key))).toEqual(["↑", "↓", "←", "→"]);
  expect(formatShortcut("alt+up")).toBe(`${ALT} ↑`);
  // Function and other named keys.
  expect(formatShortcut("f5")).toBe("F5");
  expect(formatShortcut("ctrl+f12")).toBe(`${CTRL} F12`);
  expect(["home", "end", "pageUp", "pagedown", "insert"].map((key) => formatShortcut(key)))
    .toEqual(["Home", "End", "PgUp", "PgDn", "Ins"]);
  // A trailing + is the plus key.
  expect(formatShortcut("+")).toBe("+");
  expect(formatShortcut("ctrl++")).toBe(`${CTRL} +`);
  expect(formatShortcut("alt+shift++")).toBe(`${ALT} ${SHIFT} +`);
  // A bare letter stays lowercase; in a chord it is a capital.
  expect(formatShortcut("q")).toBe("q");
  expect(formatShortcut("Q")).toBe("q");
  expect(formatShortcut("shift+q")).toBe(`${SHIFT} Q`);
  // Each icon is two UTF-16 units but one terminal cell.
  expect(formatShortcut("alt+shift+s")).toHaveLength(7);
  expect(visibleWidth(formatShortcut("alt+shift+s"))).toBe(5);
});

test("formats plain shortcuts in menu order joined with +", () => {
  const plain = (key: string) => formatShortcut(key, { icons: false });
  expect(plain("super+shift+alt+ctrl+s")).toBe("Ctrl+Alt+Shift+Cmd+S");
  expect(plain("alt+e")).toBe("Alt+E");
  expect(plain("alt+1")).toBe("Alt+1");
  expect(plain("f5")).toBe("F5");
  expect(plain("enter")).toBe("Enter");
  expect(["esc", "tab", "backspace", "delete", "space"].map(plain)).toEqual(["Esc", "Tab", "Backspace", "Delete", "Space"]);
  expect(plain("shift+tab")).toBe("Shift+Tab");
  expect(plain("alt+up")).toBe("Alt+↑");
  expect(plain("pagedown")).toBe("PgDn");
  expect(plain("q")).toBe("q");
  expect(plain("ctrl+q")).toBe("Ctrl+Q");
  expect(plain("+")).toBe("+");
  expect(plain("ctrl++")).toBe("Ctrl++");
  // Keys named like Object.prototype members are ordinary keys.
  expect(plain("constructor")).toBe("Constructor");
  expect(plain("alt+tostring")).toBe("Alt+Tostring");
});

test("formats no shortcut for a blank key or none", () => {
  for (const key of ["", "   ", "none", "NONE", " None ", "\tnone\n"]) {
    expect(formatShortcut(key)).toBe("");
    expect(formatShortcut(key, { icons: false })).toBe("");
  }
});

test("strips control characters from formatted shortcuts", () => {
  expect(formatShortcut("alt+\u0007")).toBe(ALT);
  expect(formatShortcut("\u0007")).toBe("");
  for (const key of ["alt+\u0007", "ctrl+\u001b[31mx", "\u0000s", "alt+s\u009b", "shift+\u001b]0;title\u0007q", "f5\u007f"]) {
    for (const icons of [true, false]) {
      expect(formatShortcut(key, { icons })).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(formatShortcutRange([key, key, key], { icons })).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
  }
});

test("collapses three or more consecutive digit shortcuts into a range", () => {
  const presets = ["alt+1", "alt+2", "alt+3", "alt+4", "alt+5"];
  expect(formatShortcutRange(presets)).toBe(`${ALT} 1-5`);
  expect(formatShortcutRange(presets, { icons: false })).toBe("Alt+1-5");
  expect(formatShortcutRange(["ctrl+shift+7", "shift+ctrl+8", "CTRL+SHIFT+9"], { icons: false })).toBe("Ctrl+Shift+7-9");
  expect(formatShortcutRange(["alt+0", "alt+1", "alt+2"])).toBe(`${ALT} 0-2`);
  expect(formatShortcutRange(["1", "2", "3"])).toBe("1-3");
});

test("lists shortcuts that don't make a range", () => {
  const plain = { icons: false };
  // Mixed modifiers.
  expect(formatShortcutRange(["alt+1", "ctrl+2", "alt+3"], plain)).toBe("Alt+1 Ctrl+2 Alt+3");
  expect(formatShortcutRange(["alt+1", "alt+shift+2", "alt+3"])).toBe(`${ALT} 1 ${ALT} ${SHIFT} 2 ${ALT} 3`);
  // A gap, the wrong order, or a repeat.
  expect(formatShortcutRange(["alt+1", "alt+2", "alt+4"], plain)).toBe("Alt+1 Alt+2 Alt+4");
  expect(formatShortcutRange(["alt+3", "alt+2", "alt+1"], plain)).toBe("Alt+3 Alt+2 Alt+1");
  expect(formatShortcutRange(["alt+1", "alt+1", "alt+2"], plain)).toBe("Alt+1 Alt+1 Alt+2");
  // Fewer than 3 keys.
  expect(formatShortcutRange(["alt+1", "alt+2"])).toBe(`${ALT} 1 ${ALT} 2`);
  expect(formatShortcutRange(["alt+1"], plain)).toBe("Alt+1");
  // Not digits.
  expect(formatShortcutRange(["alt+a", "alt+b", "alt+c"], plain)).toBe("Alt+A Alt+B Alt+C");
  expect(formatShortcutRange(["f1", "f2", "f3"], plain)).toBe("F1 F2 F3");
});

test("drops none and blank keys before making a range", () => {
  expect(formatShortcutRange(["alt+1", "none", "", "alt+2", " NONE ", "alt+3"])).toBe(`${ALT} 1-3`);
  expect(formatShortcutRange(["alt+1", "none", "alt+2"], { icons: false })).toBe("Alt+1 Alt+2");
  expect(formatShortcutRange(["none", "  ", ""])).toBe("");
  expect(formatShortcutRange([])).toBe("");
});

test("declares its shortcut settings in hkay.shortcutHints, outside the omp block", async () => {
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const hints: ShortcutHintDeclaration[] = manifest.hkay.shortcutHints;
  expect(hints).toEqual([
    { label: "stash", settings: ["Stash shortcut"], priority: 10 },
    { label: "stashes", settings: ["Browser shortcut"], priority: 20, command: "/stash" },
  ]);
  expect(manifest.omp.hkay).toBeUndefined();
  const defaults = hints.flatMap((hint) => hint.settings.map((setting) => {
    expect(manifest.omp.settings[setting].type).toBe("string");
    return formatShortcut(manifest.omp.settings[setting].default);
  }));
  expect(defaults).toEqual([`${ALT} S`, `${ALT} ${SHIFT} S`]);
});

test("fits the list in every terminal size with the title and search rows on top", () => {
  const failures: string[] = [];
  const widths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 20, 24, 32, 40, 48, 60, 80, 100, 120, 160];
  for (const count of [0, 1, 3, 100]) {
    for (const [shape, renderItem] of [["one-row", oneRow], ["two-row", twoRows], ["wide", wideRow]] as const) {
      for (const query of ["", "file-00", "zzz"]) {
        for (let rows = 1; rows <= 30; rows += 1) {
          const { list } = openList(fileOptions(files(count), { renderItem }), rows);
          press(list, query);
          for (const width of widths) {
            const lines = list.render(width);
            const label = `${count} ${shape} items /${query} ${width}x${rows}`;
            if (lines.length > rows) failures.push(`${label}: ${lines.length} rows`);
            if (lines.length < Math.min(rows, 2)) failures.push(`${label}: no search row`);
            const wrong = lines.find((line) => visibleWidth(line) !== width);
            if (wrong !== undefined) failures.push(`${label}: a row is ${visibleWidth(wrong)} cells wide`);
            if (width >= 20 && !lines[0]?.includes("Files")) failures.push(`${label}: no title row`);
            if (rows >= 2 && width >= 40 && !lines[1]?.includes(query || "File or folder")) {
              failures.push(`${label}: the search row isn't below the title`);
            }
          }
        }
      }
    }
  }
  expect(failures).toEqual([]);
});

test("switches to a compact layout under 12 rows", () => {
  const options = fileOptions(files(100));
  const compact = openList(options, 11).list.render(80);
  expect(compact).toHaveLength(11);
  expect(compact[0]).toStartWith("┌ Files · 100 ─");
  expect(compact[1]).toStartWith(`│ ${SEARCH} Search  `);
  expect(compact[1]).toContain("File or folder");
  expect(compact.filter((line) => line.startsWith("├"))).toEqual([]);
  expect(compact.join("\n")).not.toContain("of 100");
  expect(itemRows(compact).rows).toHaveLength(7);
  expect(compact[9]).toStartWith("│ Enter Open  Esc Close ");
  expect(compact[10]).toStartWith("└─");

  const full = openList(options, 12).list.render(80);
  expect(full).toHaveLength(12);
  expect(full.filter((line) => line.startsWith("├"))).toHaveLength(2);
  expect(itemRows(full).rows).toHaveLength(5);
  expect(full[8]).toStartWith("│ 1 of 100 · ↑↓ Move · PgUp/PgDn Page ");
  expect(full[10]).toStartWith("│ Enter Open  Esc Close ");

  // Five rows still frame the title, search row, one item, and footer.
  const tiny = openList(options, 5).list.render(80);
  expect(tiny).toHaveLength(5);
  ["┌ Files · 100 ─", `│ ${SEARCH} Search  `, "│ › file-000.ts ", "│ Enter Open  Esc Close ", "└─"]
    .forEach((start, row) => expect(tiny[row]).toStartWith(start));
});

test("pages a screen at a time and keeps the selected item in the middle", () => {
  const { list } = openList(fileOptions(files(100)), 20);
  let view = itemRows(list.render(80));
  // 20 rows less 7 rows of title, search, dividers, status, footer, and frame.
  expect(view.rows).toHaveLength(13);
  expect(view.selected).toBe(0);
  const expectSelected = (name: string, position: number) => {
    const lines = list.render(80);
    view = itemRows(lines);
    expect(view.rows[view.selected]).toContain(`› ${name}`);
    expect(view.selected).toBe(position);
  };
  list.handleInput(KEY.pageDown);
  expectSelected("file-013.ts", 6);
  expect(view.rows[0]).toContain("file-007.ts");
  expect(list.render(80).join("\n")).toContain("14 of 100 · ↑↓ Move · PgUp/PgDn Page");
  list.handleInput(KEY.pageDown);
  expectSelected("file-026.ts", 6);
  list.handleInput(KEY.pageUp);
  expectSelected("file-013.ts", 6);
  list.handleInput(KEY.down);
  expectSelected("file-014.ts", 6);
  list.handleInput(KEY.end);
  expectSelected("file-099.ts", 12);
  list.handleInput(KEY.down);
  expectSelected("file-099.ts", 12);
  list.handleInput(KEY.pageDown);
  expectSelected("file-099.ts", 12);
  list.handleInput(KEY.home);
  expectSelected("file-000.ts", 0);
  list.handleInput(KEY.up);
  list.handleInput(KEY.pageUp);
  expectSelected("file-000.ts", 0);
});

test("draws two-row items and pages by whole items", () => {
  const compactness: boolean[] = [];
  const { list, tui } = openList(fileOptions(files(100), {
    renderItem: (file, row) => {
      compactness.push(row.compact);
      return [`${file.name} ${row.width}`, `  ${file.folder}`];
    },
  }), 20);
  let lines = list.render(80);
  // 13 free rows hold 6 two-row items.
  expect(itemRows(lines).rows).toHaveLength(12);
  expect(lines[3]).toStartWith("│ › file-000.ts 74 ");
  expect(lines[4]).toStartWith("│     src/part-0 ");
  expect(lines[5]).toStartWith("│   file-001.ts 74 ");
  expect(lines[6]).toStartWith("│     src/part-1 ");
  list.handleInput(KEY.pageDown);
  lines = list.render(80);
  expect(lines.join("\n")).toContain("7 of 100");
  expect(itemRows(lines).selected).toBe(6);
  expect(lines[9]).toStartWith("│ › file-006.ts");
  expect(lines[10]).toStartWith("│     src/part-6");
  expect(compactness.every((compact) => !compact)).toBeTrue();
  // The compact layout shows only each item's first row.
  tui.terminal.rows = 11;
  compactness.length = 0;
  lines = list.render(80);
  expect(lines).toHaveLength(11);
  expect(lines.join("\n")).not.toContain("src/part-");
  expect(itemRows(lines).rows).toHaveLength(7);
  expect(compactness.length > 0 && compactness.every(Boolean)).toBeTrue();
});

test("closes with an action's result or keeps the list open and repaints it", async () => {
  const revealed: string[] = [];
  // What the async actions returned, so the test can wait for the list to settle them.
  const pending: { wait?: Promise<undefined>; fail?: Promise<never> } = {};
  const { list, tui, result, outcome } = openList(fileOptions(files(5), {
    actions: [
      { key: "enter", label: "Open", run: (file) => file?.name },
      {
        key: "ctrl+o",
        label: "Reveal",
        run: (file) => {
          if (file) revealed.push(file.name);
        },
      },
      { key: "tab", label: "Wait", run: () => (pending.wait = Promise.resolve(undefined)) },
      { key: "ctrl+x", label: "Fail", run: () => (pending.fail = Promise.reject(new Error("the action failed"))) },
      { key: "ctrl+r", label: "Later", run: async (file) => `${file?.name} later` },
    ],
  }), 20);
  expect(list.render(120).join("\n")).toContain("Enter Open  Ctrl+O Reveal  Tab Wait  Ctrl+X Fail  Ctrl+R Later  Esc Close");
  list.handleInput(KEY.down);
  const steps: [string, () => Promise<unknown> | undefined][] = [
    [KEY.ctrlO, () => undefined],
    [KEY.tab, () => pending.wait],
    [KEY.ctrlX, () => pending.fail?.catch(() => undefined)],
  ];
  for (const [key, settled] of steps) {
    const renders = tui.renders;
    list.handleInput(key);
    // The list's handlers were attached first, so they have run once this settles.
    await settled();
    await Promise.resolve();
    expect(outcome.closed).toBeFalse();
    expect(tui.renders).toBeGreaterThan(renders);
  }
  expect(revealed).toEqual(["file-001.ts"]);
  // The list is still live after those actions.
  list.handleInput(KEY.down);
  list.handleInput(KEY.ctrlR);
  expect(await result).toBe("file-002.ts later");

  const second = openList(fileOptions(files(5)));
  second.list.handleInput(KEY.end);
  second.list.handleInput(KEY.enter);
  expect(await second.result).toBe("file-004.ts");
});

test("wraps footer hints onto two rows, then shows only their keys", () => {
  const actions = ["enter", "ctrl+o", "tab", "ctrl+r"].map((key, index) => ({
    key,
    label: `Action number ${index + 1}`,
    run: () => undefined,
  }));
  const wrapped = openList(fileOptions(files(3), { actions }), 20).list.render(60);
  expect(wrapped.at(-3)).toStartWith("│ Enter Action number 1  Ctrl+O Action number 2 ");
  expect(wrapped.at(-2)).toStartWith("│ Tab Action number 3  Ctrl+R Action number 4  Esc Close ");
  const keys = openList(fileOptions(files(3), { actions }), 20).list.render(40);
  expect(keys.at(-2)).toStartWith("│ Enter  Ctrl+O  Tab  Ctrl+R  Esc ");
  // The compact layout has one footer row.
  const compact = openList(fileOptions(files(3), { actions }), 8).list.render(60);
  expect(compact.at(-2)).toStartWith("│ Enter  Ctrl+O  Tab  Ctrl+R  Esc ");
});

test("closes on Esc, Ctrl+C, or the toggle key", async () => {
  for (const [toggleKey, key] of [[undefined, KEY.escape], [undefined, KEY.ctrlC], ["alt+n", KEY.altN], [" Alt+N ", KEY.altN]]) {
    const { list, result } = openList(fileOptions(files(3), { toggleKey }));
    list.handleInput(KEY.down);
    list.handleInput("f");
    list.handleInput(key as string);
    expect(await result).toBeUndefined();
  }
  for (const toggleKey of [undefined, "none", " NONE ", ""]) {
    const { list, outcome } = openList(fileOptions(files(3), { toggleKey }));
    list.handleInput(KEY.altN);
    await Promise.resolve();
    expect(outcome.closed).toBeFalse();
  }
});

test("shows the empty label when the search matches nothing", async () => {
  const runs: (string | undefined)[] = [];
  const { list, result, outcome } = openList(fileOptions(files(5), {
    emptyLabel: ({ query, total, matches }) => `No match for ${query} in ${total} files (${matches.length})`,
    actions: [{
      key: "enter",
      label: "Open",
      run: (file) => {
        runs.push(file?.name);
        return file?.name;
      },
    }],
  }), 20);
  press(list, "zzz");
  let lines = list.render(80);
  expect(lines[0]).toStartWith("┌ Files · 0 of 5 ─");
  expect(lines[1]).toContain("zzz");
  expect(lines[3]).toStartWith("│ No match for zzz in 5 files (0) ");
  expect(lines.join("\n")).not.toContain(" of 0");
  expect(lines.at(-2)).toStartWith("│ Enter Open  Esc Close ");
  // Enter runs the action with no item, and the list stays open.
  list.handleInput(KEY.enter);
  await Promise.resolve();
  expect(runs).toEqual([undefined]);
  expect(outcome.closed).toBeFalse();
  press(list, [KEY.backspace, KEY.backspace, KEY.backspace]);
  lines = list.render(80);
  expect(lines[3]).toStartWith("│ › file-000.ts ");
  list.handleInput(KEY.down);
  list.handleInput(KEY.enter);
  expect(await result).toBe("file-001.ts");

  const empty = openList(fileOptions([]), 20).list.render(80);
  expect(empty[3]).toStartWith("│ No items ");
  const unmatched = openList(fileOptions(files(2)), 20).list;
  press(unmatched, "zzz");
  expect(unmatched.render(80)[3]).toStartWith("│ No matching items ");
});

test("matches every search word ignoring case, or uses a custom filter", () => {
  const { list } = openList(fileOptions(files(30)), 40);
  press(list, "PART-3 File-01");
  const lines = list.render(80);
  expect(lines[0]).toStartWith("┌ Files · 2 of 30 ─");
  expect(itemRows(lines).rows.map((line) => line.slice(4, 15))).toEqual(["file-010.ts", "file-017.ts"]);

  const strings = openList({ items: ["Alpha", "Beta", "alphabet"], title: "Pick", renderItem: (item: string) => [item] }, 20);
  press(strings.list, "ALPH");
  expect(itemRows(strings.list.render(80)).rows).toEqual([]);
  expect(strings.list.render(80).filter((line) => line.includes("lpha"))).toHaveLength(2);

  const reversed = openList(fileOptions(files(3), { filter: (items, query) => (query ? [] : [...items].reverse()) }), 20);
  expect(itemRows(reversed.list.render(80)).rows[0]).toContain("› file-002.ts");
  press(reversed.list, "f");
  expect(reversed.list.render(80)[3]).toStartWith("│ No matching items ");
});

test("keeps the selection on the same item while the items change", async () => {
  let items = files(5);
  const { list, result } = openList(fileOptions(() => items, { id: (file) => file.name }), 20);
  press(list, [KEY.down, KEY.down]);
  expect(list.render(80).join("\n")).toContain("› file-002.ts");
  // New objects for the same files, with a new file on top.
  items = [{ name: "new.ts", folder: "src" }, ...items.map((file) => ({ ...file }))];
  expect(list.render(80).join("\n")).toContain("› file-002.ts");
  expect(list.render(80).join("\n")).toContain("4 of 6");
  // When the selected item goes away, the first item is selected.
  items = items.filter((file) => file.name !== "file-002.ts");
  expect(list.render(80).join("\n")).toContain("› new.ts");
  list.handleInput(KEY.down);
  list.handleInput(KEY.enter);
  expect(await result).toBe("file-000.ts");
});

test("opens on the selected item and lets an owner component select another", () => {
  const items = files(30);
  const opened = openList(fileOptions(items, { selected: items[20] }), 20);
  expect(opened.list.render(80).join("\n")).toContain("› file-020.ts");

  const closed: (string | undefined)[] = [];
  const tui = fakeTui(20);
  const list = createList(tui as unknown as TUI, PLAIN_THEME, fileOptions(items), (value) => closed.push(value));
  expect(list.render(80).join("\n")).toContain("› file-000.ts");
  list.select(items[7]!);
  expect(list.render(80).join("\n")).toContain("› file-007.ts");
  list.select({ name: "missing.ts", folder: "src" });
  expect(list.render(80).join("\n")).toContain("› file-000.ts");
  list.handleInput(KEY.end);
  list.handleInput(KEY.enter);
  list.handleInput(KEY.escape);
  expect(closed).toEqual(["file-029.ts", undefined]);
});

test("styles the selected row and lets OMP use the terminal cursor in the search field", () => {
  const { list } = openList(fileOptions(files(3)), 20, ANSI_THEME);
  const lines = list.render(80);
  expect(lines[3]).toContain("\u001b[48;5;236m\u001b[38;5;33m› \u001b[39mfile-000.ts");
  expect(lines[4]).not.toContain("\u001b[48;5;236m");
  list.handleInput("f");
  expect(list.render(80)[1]).toContain("\u001b[7m \u001b[27m");
  list.setUseTerminalCursor?.(true);
  expect(list.render(80)[1]).not.toContain("\u001b[7m");
  list.focused = false;
  expect(list.render(80)[1]).not.toContain("\u001b_pi:c\u0007");
});

test("types printable keys into the search, even keys that actions use", async () => {
  const ran: string[] = [];
  const actions = ["d", "space", "q", "Q", "shift+q", "1", "ctrl+o", "alt+d"]
    .map((key) => ({ key, label: key, run: () => void ran.push(key) }));
  const { list, outcome } = openList(fileOptions(files(5), { actions }), 20);
  // One key per event, as a terminal sends them, plus Kitty's CSI-u forms of q and Shift+Q.
  press(list, ["d", " ", "q", "Q", "1", "\u001b[113u", "\u001b[113:81;2u"]);
  await Promise.resolve();
  expect(ran).toEqual([]);
  expect(list.render(80)[1]).toContain("d qQ1qQ");
  // Modifier combinations still run their actions.
  press(list, [KEY.ctrlO, "\u001bd"]);
  expect(ran).toEqual(["ctrl+o", "alt+d"]);
  expect(outcome.closed).toBeFalse();
});

test("ignores action keys while an async action is pending", async () => {
  let runs = 0;
  const settles: PromiseWithResolvers<string | undefined>[] = [];
  const { list, tui, result, outcome } = openList(fileOptions(files(3), {
    actions: [{
      key: "enter",
      label: "Open",
      run: () => {
        runs += 1;
        const pending = Promise.withResolvers<string | undefined>();
        settles.push(pending);
        return pending.promise;
      },
    }],
  }), 20);
  list.handleInput(KEY.enter);
  list.handleInput(KEY.enter);
  expect(runs).toBe(1);
  // Other keys still work meanwhile.
  list.handleInput(KEY.down);
  expect(list.render(80).join("\n")).toContain("› file-001.ts");
  // A rejection repaints the open list and turns the actions back on. The list's handlers were attached
  // first, so they have run once the promise settles here.
  const renders = tui.renders;
  settles[0]?.reject(new Error("the action failed"));
  await settles[0]?.promise.catch(() => undefined);
  expect(tui.renders).toBeGreaterThan(renders);
  expect(outcome.closed).toBeFalse();
  list.handleInput(KEY.enter);
  list.handleInput(KEY.enter);
  expect(runs).toBe(2);
  // So does a result of undefined.
  settles[1]?.resolve(undefined);
  await settles[1]?.promise;
  expect(outcome.closed).toBeFalse();
  list.handleInput(KEY.enter);
  expect(runs).toBe(3);
  settles[2]?.resolve("file-001.ts");
  expect(await result).toBe("file-001.ts");
});

test("draws the search glyph unless icons are off", () => {
  const icons = openList(fileOptions(files(3)), 20).list.render(80);
  expect(icons[1]).toStartWith(`│ ${SEARCH} Search  `);
  expect(icons[1]).toContain("File or folder");
  const plain = openList(fileOptions(files(3), { icons: false }), 20).list.render(80);
  expect(plain[1]).toStartWith("│ Search  ");
  expect(plain.join("\n")).not.toContain(SEARCH);
});

test("keeps the selection on a rebuilt item by its search text when there is no id", () => {
  let items = files(5);
  const { list } = openList(fileOptions(() => items), 20);
  press(list, [KEY.down, KEY.down]);
  items = items.map((file) => ({ ...file }));
  expect(list.render(80).join("\n")).toContain("› file-002.ts");
  list.handleInput(KEY.down);
  items = items.map((file) => ({ ...file }));
  expect(list.render(80).join("\n")).toContain("› file-003.ts");
});

// selectOption 1.10.4 and now, driven with the same keys and terminal sizes.
type Picker = { handleInput(data: string): void; render(width: number): readonly string[]; focused: boolean };

function mountPicker(
  select: typeof selectOption,
  tui: FakeTui,
  options: string[],
  iconKey?: string,
  settings?: SelectOptionSettings,
) {
  let component: Picker | undefined;
  let mountOptions: unknown;
  const ctx = {
    ui: {
      custom(factory: (tui: FakeTui, theme: Theme, keybindings: unknown, done: (value: string | undefined) => void) => Picker, given: unknown) {
        mountOptions = given;
        const { promise, resolve } = Promise.withResolvers<string | undefined>();
        component = factory(tui, ANSI_THEME, undefined, resolve);
        return promise;
      },
    },
  } as unknown as ExtensionContext;
  const outcome: Outcome<string> = { closed: false };
  void select(ctx, "Choose a model", options, iconKey, settings).then((value) => Object.assign(outcome, { closed: true, value }));
  if (!component) throw new Error("The picker was not presented");
  return { component, mountOptions, outcome };
}

test("renders selectOption exactly as 1.10.4 did, with the same keys and results", async () => {
  const optionSets = [
    [],
    ["Alpha"],
    ["Alpha", "Beta", "Gamma"],
    Array.from({ length: 50 }, (_, index) => `Option ${String(index).padStart(2, "0")}`),
    ["Same", "Same", "Other", "Same"],
    ["漢字 wide option label that needs clipping in narrow rows", "emoji 🎉 option", `${nerd["icon.model"]} icon option`, "plain"],
  ];
  // A number resizes the terminal to that many rows.
  const sequences: (string | number)[][] = [
    [],
    [KEY.down, KEY.down, KEY.up],
    [KEY.pageDown, KEY.pageDown, KEY.pageUp],
    [KEY.end, KEY.home, KEY.up],
    ["o", "p", "t", KEY.backspace],
    ["4", "2"],
    ["z", "z", "z", KEY.enter, KEY.down],
    [KEY.down, "e", KEY.down, KEY.down],
    ["a", KEY.left, "l", KEY.ctrlU],
    [KEY.down, KEY.down, KEY.down, 4, KEY.pageDown, 20, KEY.pageUp, 2, KEY.down],
  ];
  const widths = [1, 3, 4, 5, 8, 20, 31, 32, 33, 40, 65, 66, 67, 80, 120];
  const failures: string[] = [];
  for (const [set, options] of optionSets.entries()) {
    for (const iconKey of [undefined, "icon.model"]) {
      for (const rows of [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 17, 20, 40]) {
        for (const sequence of sequences) {
          const tui = fakeTui(rows);
          const before = mountPicker(selectOption1104, tui, options, iconKey);
          const after = mountPicker(selectOption, tui, options, iconKey);
          const label = `options ${set}, ${iconKey ?? "no icon"}, ${rows} rows, [${sequence.map((step) => JSON.stringify(step)).join(" ")}]`;
          const compare = (step: string) => {
            for (const width of widths) {
              const expected = before.component.render(width);
              const actual = after.component.render(width);
              if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${label} after ${step} at width ${width}`);
            }
          };
          compare("opening");
          for (const step of sequence) {
            if (typeof step === "number") {
              tui.terminal.rows = step;
            } else {
              before.component.handleInput(step);
              after.component.handleInput(step);
            }
            compare(JSON.stringify(step));
          }
          before.component.focused = false;
          after.component.focused = false;
          compare("losing focus");
          before.component.focused = true;
          after.component.focused = true;
          before.component.handleInput(KEY.enter);
          after.component.handleInput(KEY.enter);
          await Promise.resolve();
          if (JSON.stringify(after.outcome) !== JSON.stringify(before.outcome)) failures.push(`${label}: Enter gave a different result`);
          before.component.handleInput(KEY.escape);
          after.component.handleInput(KEY.escape);
          await Promise.resolve();
          if (JSON.stringify(after.outcome) !== JSON.stringify(before.outcome)) failures.push(`${label}: Esc gave a different result`);
          expect(after.mountOptions).toBe(OVERLAY_OPTIONS);
          expect(before.mountOptions).toEqual(OVERLAY_OPTIONS);
          // 1.10.4 always drew its own cursor in the search field.
          expect("setUseTerminalCursor" in after.component).toBeFalse();
        }
      }
    }
  }
  expect(failures.slice(0, 20)).toEqual([]);
});

test("cancels selectOption with Ctrl+C as 1.10.4 did", async () => {
  for (const select of [selectOption1104, selectOption]) {
    const picker = mountPicker(select, fakeTui(12), ["Alpha", "Beta"]);
    picker.component.handleInput("b");
    picker.component.handleInput(KEY.ctrlC);
    await Promise.resolve();
    expect(picker.outcome).toEqual({ closed: true, value: undefined });
  }
});

test("selectOption drops its glyphs without icons and opens on the selected option", async () => {
  const options = Array.from({ length: 30 }, (_, index) => `Option ${String(index).padStart(2, "0")}`);
  const plain = mountPicker(selectOption, fakeTui(20), options, "icon.model", { icons: false, selected: "Option 24" });
  const lines = plain.component.render(80).map((line) => Bun.stripANSI(line));
  expect(lines[0]).toStartWith("┌ Choose a model ─");
  expect(lines[1]).toStartWith("│ / ");
  expect(lines.join("\n")).not.toContain(nerd["icon.model"]);
  expect(lines.join("\n")).not.toContain(SEARCH);
  expect(lines.find((line) => line.includes(" > "))).toStartWith("│ > Option 24");
  plain.component.handleInput(KEY.enter);
  await Promise.resolve();
  expect(plain.outcome).toEqual({ closed: true, value: "Option 24" });

  // Icons stay on by default, and an option that isn't listed selects the first one.
  const icons = mountPicker(selectOption, fakeTui(20), options, "icon.model", { selected: "Missing" });
  const iconLines = icons.component.render(80).map((line) => Bun.stripANSI(line));
  expect(iconLines[0]).toStartWith(`┌ ${nerd["icon.model"]} Choose a model ─`);
  expect(iconLines[1]).toStartWith(`│ ${SEARCH} `);
  expect(iconLines.find((line) => line.includes(" > "))).toStartWith("│ > Option 00");
});
