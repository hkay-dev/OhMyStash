// @bun
// extensions/prompt-stash.ts
import { createHash, randomUUID as randomUUID2 } from "crypto";
import {
  closeSync,
  constants,
  existsSync as existsSync2,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync as lstatSync2,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  utimesSync,
  watch,
  writeFileSync
} from "fs";
import { basename, dirname as dirname2, join as join2, resolve as resolve2 } from "path";
import { pathToFileURL } from "url";
import {
  getAgentDir
} from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components";
import { getEditorCommand, openInEditor } from "@oh-my-pi/pi-coding-agent/utils/external-editor";
import {
  extractPrintableText as extractPrintableText2,
  fuzzyFilter as fuzzyFilter2,
  Input as Input2,
  Key as Key2,
  matchesKey as matchesKey2,
  replaceTabs,
  truncateToWidth as truncateToWidth2,
  visibleWidth as visibleWidth2
} from "@oh-my-pi/pi-tui";
import { SYMBOL_PRESETS as SYMBOL_PRESETS2 } from "@oh-my-pi/pi-tui/theme/symbols";

// extensions/ui.ts
import {
  extractPrintableText,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth
} from "@oh-my-pi/pi-tui";
import { SYMBOL_PRESETS } from "@oh-my-pi/pi-tui/theme/symbols";

// extensions/native-ui.ts
var NATIVE_UI_CHANNEL = "ohmystash:native-ui";
function collectNativeHost(events) {
  let found;
  const request = {
    add(host) {
      if (!found && typeof host?.list === "function" && typeof host.close === "function" && typeof host.edit === "function") {
        found = host;
      }
    }
  };
  events?.emit(NATIVE_UI_CHANNEL, request);
  return found;
}
async function pickNativeOption(host, spec) {
  const selected = spec.selected === undefined ? -1 : spec.options.indexOf(spec.selected);
  try {
    const event = await host.list({
      id: spec.id,
      title: spec.title,
      ...spec.placeholder === undefined ? {} : { placeholder: spec.placeholder },
      ...selected === -1 ? {} : { selected: String(selected) },
      items: spec.options.map((option, index) => ({ id: String(index), title: option })),
      actions: [{ id: "select", label: "Select", key: "enter", close: true }]
    });
    if (event.type !== "action" || event.action !== "select" || event.item === undefined)
      return;
    return spec.options[Number(event.item)];
  } finally {
    await host.close(spec.id);
  }
}

// extensions/ui.ts
var OVERLAY_OPTIONS = { overlay: true };
function extensionIcon(key) {
  const glyph = SYMBOL_PRESETS.nerd[key];
  return typeof glyph === "string" ? glyph : "";
}
function fitToWidth(text, width) {
  const clipped = truncateToWidth(text, Math.max(0, width));
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}
function createFrame(theme, width) {
  const renderWidth = Math.max(1, Math.floor(width));
  const contentWidth = Math.max(0, renderWidth - 2);
  const border = (text) => theme.fg("accent", text);
  const heading = (label) => theme.fg("accent", theme.bold(truncateToWidth(` ${label} `, contentWidth, "")));
  const line = (left, content, right) => renderWidth === 1 ? border(left) : `${border(left)}${content}${border(right)}`;
  return {
    top(title) {
      const titleText = heading(title);
      return line("\u250C", `${titleText}${border("\u2500".repeat(Math.max(0, contentWidth - visibleWidth(titleText))))}`, "\u2510");
    },
    row(text = "") {
      return line("\u2502", fitToWidth(text, contentWidth), "\u2502");
    },
    divider(label = "") {
      const titleText = label ? heading(label) : "";
      const fill = "\u2500".repeat(Math.max(0, contentWidth - visibleWidth(titleText)));
      return line("\u251C", `${titleText}${label ? theme.fg("muted", fill) : border(fill)}`, "\u2524");
    },
    bottom() {
      return line("\u2514", border("\u2500".repeat(contentWidth)), "\u2518");
    }
  };
}
var nerd = SYMBOL_PRESETS.nerd;
var MAC_MODIFIER_LABELS = {
  ctrl: [nerd["key.ctrlMac"], "Ctrl"],
  alt: [nerd["key.altMac"], "Alt"],
  shift: [nerd["key.shift"], "Shift"],
  super: [nerd["key.superMac"], "Cmd"]
};
var PC_MODIFIER_LABELS = {
  ctrl: [nerd["key.ctrl"], "Ctrl"],
  alt: [nerd["key.alt"], "Alt"],
  shift: [nerd["key.shift"], "Shift"],
  super: [nerd["key.super"], "Super"]
};
var KEY_LABELS = {
  esc: [nerd["key.esc"], "Esc"],
  escape: [nerd["key.esc"], "Esc"],
  enter: [nerd["key.enter"], "Enter"],
  return: [nerd["key.enter"], "Enter"],
  tab: [nerd["key.tab"], "Tab"],
  backspace: [nerd["key.backspace"], "Backspace"],
  delete: [nerd["key.delete"], "Delete"],
  space: [nerd["key.space"], "Space"],
  up: ["\u2191", "\u2191"],
  down: ["\u2193", "\u2193"],
  left: ["\u2190", "\u2190"],
  right: ["\u2192", "\u2192"],
  home: ["Home", "Home"],
  end: ["End", "End"],
  pageup: ["PgUp", "PgUp"],
  pagedown: ["PgDn", "PgDn"],
  insert: ["Ins", "Ins"]
};
function isPromiseLike(value) {
  return typeof value?.then === "function";
}
function listComponent(tui, theme, options, done, layout, initialPageSize, terminalCursor) {
  let drawnPageSize = typeof initialPageSize === "number" ? initialPageSize : 1;
  const pageSize = () => typeof initialPageSize === "function" ? initialPageSize() : drawnPageSize;
  const input = new Input;
  input.prompt = "";
  input.focused = true;
  const source = options.items;
  const id = (item) => options.id ? options.id(item) : item;
  const searchText = (item) => options.search ? options.search(item) : String(item);
  const matchWords = (items, query) => {
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0)
      return items;
    return items.filter((item) => {
      const text = searchText(item).toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    });
  };
  const toggle = options.toggleKey?.trim() ?? "";
  const toggleKey = toggle && toggle.toLowerCase() !== "none" ? toggle : undefined;
  let filtered;
  let index = 0;
  let anchored = false;
  let anchor;
  let anchorText;
  const anchorOn = (item, found) => {
    anchored = found;
    anchor = found ? id(item) : undefined;
    anchorText = found && !options.id ? searchText(item) : undefined;
  };
  anchorOn(options.selected, options.selected !== undefined);
  const anchorIndex = (matches) => {
    const same = matches.findIndex((item) => Object.is(id(item), anchor));
    if (same !== -1 || anchorText === undefined)
      return same;
    return matches.findIndex((item) => searchText(item) === anchorText);
  };
  let pending = false;
  const view = () => {
    const items = typeof source === "function" ? source() : source;
    const query = input.getValue();
    if (typeof source === "function" || filtered?.items !== items || filtered.query !== query) {
      filtered = { items, query, matches: options.filter ? options.filter(items, query) : matchWords(items, query) };
    }
    const { matches } = filtered;
    if (!(anchored && index < matches.length && Object.is(id(matches[index]), anchor))) {
      index = anchored ? Math.max(0, anchorIndex(matches)) : 0;
    }
    const selected = matches[index];
    anchorOn(selected, index < matches.length);
    return { theme, input, rows: Math.max(1, tui.terminal.rows), query, matches, total: items.length, selected, index };
  };
  const settle = (result) => {
    if (isPromiseLike(result)) {
      pending = true;
      result.then((value) => {
        pending = false;
        settle(value);
      }, () => {
        pending = false;
        tui.requestRender();
      });
    } else if (result === undefined) {
      tui.requestRender();
    } else {
      done(result);
    }
  };
  const component = {
    get focused() {
      return input.focused;
    },
    set focused(value) {
      input.focused = value;
    },
    invalidate() {
      input.invalidate();
    },
    select(item) {
      anchorOn(item, true);
      index = 0;
      tui.requestRender();
    },
    handleInput(data) {
      const typed = input.focused && extractPrintableText(data) !== undefined;
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || !typed && toggleKey !== undefined && matchesKey(data, toggleKey)) {
        done(undefined);
        return;
      }
      const action = typed ? undefined : options.actions?.find((candidate) => matchesKey(data, candidate.key));
      const list = view();
      if (action) {
        if (!pending)
          settle(action.run(list.selected));
        return;
      }
      const target = matchesKey(data, Key.up) ? list.index - 1 : matchesKey(data, Key.down) ? list.index + 1 : matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? list.matches.length - 1 : matchesKey(data, Key.pageUp) ? list.index - pageSize() : matchesKey(data, Key.pageDown) ? list.index + pageSize() : undefined;
      if (target === undefined) {
        const before = input.getValue();
        input.handleInput(data);
        if (input.getValue() !== before) {
          index = 0;
          anchored = false;
        }
      } else {
        index = Math.max(0, Math.min(list.matches.length - 1, target));
        anchorOn(list.matches[index], index < list.matches.length);
      }
      tui.requestRender();
    },
    render(width) {
      const drawn = layout(view(), width);
      drawnPageSize = drawn.pageSize;
      return drawn.lines;
    }
  };
  if (terminalCursor)
    component.setUseTerminalCursor = (value) => input.setUseTerminalCursor(value);
  return component;
}
function drawOptions(title, list, width, icons) {
  const { theme, input: searchInput, matches: filtered, index: selected } = list;
  const renderWidth = Math.max(1, Math.floor(width));
  const terminalRows = list.rows;
  const contentWidth = Math.max(0, renderWidth - 2);
  const keyHint = (key, label) => `${theme.fg("accent", key)} ${theme.fg("dim", label)}`;
  const hints = contentWidth >= 64 ? [keyHint("\u2191\u2193", "Move"), keyHint("PgUp/PgDn", "Page"), keyHint("Enter", "Select"), keyHint("Esc", "Close")].join("  ") : contentWidth >= 30 ? [keyHint("\u2191\u2193", "Move"), keyHint("Enter", "Select"), keyHint("Esc", "Close")].join("  ") : theme.fg("accent", "\u2191\u2193 Enter Esc");
  const option = filtered[selected];
  const emptyLabel = list.total === 0 ? "No options available" : "No matching options";
  if (terminalRows < 3 || renderWidth < 4) {
    const lines = [
      theme.fg("accent", theme.bold(truncateToWidth(option ?? emptyLabel, renderWidth, ""))),
      truncateToWidth(searchInput.getValue() ? `/${searchInput.getValue()}` : hints, renderWidth, "")
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
  const firstIndex = Math.min(Math.max(0, selected - Math.floor(listRows / 2)), Math.max(0, filtered.length - listRows));
  const lines = [frame.top(title)];
  if (showSearch) {
    const prefix = ` ${theme.fg("accent", icons ? extensionIcon("icon.search") : "/")} `;
    const fieldWidth = Math.max(1, contentWidth - visibleWidth(prefix));
    const field = searchInput.render(searchInput.getValue() ? fieldWidth : 1)[0] ?? "";
    const placeholder = searchInput.getValue() ? "" : theme.fg("dim", "Type to search");
    lines.push(frame.row(`${prefix}${field}${placeholder}`));
  }
  if (showDivider) {
    lines.push(frame.divider(searchInput.getValue() ? `Matches \xB7 ${filtered.length}/${list.total}` : `Options \xB7 ${filtered.length}`));
  }
  for (let row = 0;row < listRows; row += 1) {
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
  if (showHints)
    lines.push(frame.row(` ${hints}`));
  lines.push(frame.bottom());
  return { lines, pageSize: pageRows };
}
function selectOption(ctx, title, options, iconKey, settings) {
  const native = settings?.native;
  const host = native ? collectNativeHost(native.events) : undefined;
  const terminal = () => selectOptionInTerminal(ctx, title, options, iconKey, settings);
  if (!native || !host)
    return terminal();
  return pickNativeOption(host, {
    id: native.id,
    title,
    options,
    ...settings?.selected === undefined ? {} : { selected: settings.selected }
  }).catch(terminal);
}
function selectOptionInTerminal(ctx, title, options, iconKey, settings) {
  return ctx.ui.custom((tui, theme, _keybindings, done) => {
    const icons = settings?.icons ?? true;
    const glyph = icons && iconKey ? extensionIcon(iconKey) : "";
    const popupTitle = glyph ? `${glyph} ${title}` : title;
    const list = {
      items: options,
      title: popupTitle,
      filter: (items, query) => fuzzyFilter(items, query, (option) => option),
      renderItem: (option) => [option],
      actions: [{ key: "enter", label: "Select", run: (option) => option }],
      ...settings?.selected === undefined ? {} : { selected: settings.selected }
    };
    const pageSize = () => Math.max(1, Math.min(12, tui.terminal.rows - 5));
    return listComponent(tui, theme, list, done, (view, width) => drawOptions(popupTitle, view, width, icons), pageSize, false);
  }, OVERLAY_OPTIONS);
}

// extensions/send-targets.ts
var SEND_TARGETS_CHANNEL = "ohmystash:send-targets";
function collectSendTargets(events) {
  const targets = [];
  const request = {
    add(target) {
      if (typeof target?.label === "string" && target.label.trim() && typeof target.send === "function") {
        targets.push(target);
      }
    }
  };
  events?.emit(SEND_TARGETS_CHANNEL, request);
  return targets;
}

// extensions/storage-permissions.ts
import { spawnSync } from "child_process";
import { existsSync, lstatSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";

// extensions/storage-acl-transport.mjs
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { dlopen, ptr } from "bun:ffi";
function createWindowsAclTransport(helperPath, timeoutMs = 60000) {
  let worker;
  let library;
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  function api() {
    library ??= dlopen("kernel32.dll", {
      CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "ptr" },
      WaitNamedPipeW: { args: ["ptr", "u32"], returns: "bool" },
      SetNamedPipeHandleState: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "bool" },
      GetNamedPipeServerProcessId: { args: ["ptr", "ptr"], returns: "bool" },
      WriteFile: { args: ["ptr", "ptr", "u32", "ptr", "ptr"], returns: "bool" },
      ReadFile: { args: ["ptr", "ptr", "u32", "ptr", "ptr"], returns: "bool" },
      GetLastError: { args: [], returns: "u32" },
      CloseHandle: { args: ["ptr"], returns: "bool" }
    });
    return library.symbols;
  }
  function warm() {
    if (worker && !worker.failed)
      return worker;
    const name = `omp-oms-${process.pid}-${randomUUID()}`;
    const child = spawn(helperPath, [name, String(process.pid)], { stdio: "ignore", windowsHide: true });
    const current = { child, name: Buffer.from(`\\\\.\\pipe\\${name}\x00`, "utf16le"), failed: false };
    worker = current;
    child.on("error", () => {
      current.failed = true;
    });
    child.on("exit", () => {
      current.failed = true;
    });
    child.unref();
    return current;
  }
  function stop() {
    const previous = worker;
    worker = undefined;
    previous?.child.kill();
  }
  function request(payload) {
    const native = api();
    const current = warm();
    const deadline = performance.now() + timeoutMs;
    let handle;
    try {
      const connectDeadline = Math.min(deadline, performance.now() + 5000);
      while (performance.now() < connectDeadline && !current.failed) {
        native.WaitNamedPipeW(ptr(current.name), 20);
        handle = native.CreateFileW(ptr(current.name), 3221225472, 0, null, 3, 0, null);
        if (handle && handle !== -1 && handle !== 18446744073709552000 && handle !== 0xffffffffffffffffn)
          break;
        handle = undefined;
        Atomics.wait(sleep, 0, 0, 1);
      }
      if (!handle)
        throw new Error("ACL worker connection failed");
      const serverPid = new Uint32Array(1);
      const identityOk = native.GetNamedPipeServerProcessId(handle, ptr(serverPid));
      if (!identityOk || serverPid[0] !== current.child.pid) {
        throw new Error("ACL worker identity mismatch");
      }
      const mode = new Uint32Array([3]);
      if (!native.SetNamedPipeHandleState(handle, ptr(mode), null, null))
        throw new Error("ACL pipe setup failed");
      const input = Buffer.from(JSON.stringify(payload) + `
`, "utf8");
      if (input.length > 65536)
        throw new Error("ACL request exceeds limit");
      const count = new Uint32Array(1);
      if (!native.WriteFile(handle, ptr(input), input.length, ptr(count), null) || count[0] !== input.length) {
        throw new Error("ACL worker write failed");
      }
      const buffer = Buffer.allocUnsafe(65536);
      const chunks = [];
      let total = 0;
      while (performance.now() < deadline) {
        count[0] = 0;
        const complete = native.ReadFile(handle, ptr(buffer), buffer.length, ptr(count), null);
        const error = complete ? 0 : native.GetLastError();
        if (count[0]) {
          total += count[0];
          if (total > 32 * 1024 * 1024)
            throw new Error("ACL reply exceeds limit");
          chunks.push(Buffer.from(buffer.subarray(0, count[0])));
        }
        if (complete)
          return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
        if (error !== 232 && error !== 234 && error !== 536)
          throw new Error("ACL worker read failed");
        if (!count[0])
          Atomics.wait(sleep, 0, 0, 1);
      }
      throw new Error("ACL worker timed out");
    } catch (error) {
      stop();
      throw error;
    } finally {
      if (handle)
        native.CloseHandle(handle);
    }
  }
  return { warm, request, stop };
}

// extensions/storage-permissions.ts
var helperPath = fileURLToPath(new URL("./storage-permissions.ps1", import.meta.url));
var workerPath = fileURLToPath(new URL("./storage-acl-worker.exe", import.meta.url));
var workerTransport = createWindowsAclTransport(workerPath);
function warmStoragePermissions() {
  if (process.platform === "win32" && process.env.OMS_ACL_TRANSPORT !== "oneshot" && existsSync(workerPath))
    workerTransport.warm();
}
function stopStoragePermissions() {
  workerTransport.stop();
}
function queryPowerShell(action, path, root) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot))
    throw new Error("Windows ACL helper is unavailable");
  const command = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "psmodulepath")
      delete environment[key];
  }
  environment.PSModulePath = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
  const cache = action === "check" ? root : path;
  const result = spawnSync(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath], {
    input: JSON.stringify({ action, path, root, cache }),
    encoding: "utf8",
    env: environment,
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error || result.status !== 0)
    throw new Error("Windows ACL validation failed");
  const reply = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
  if (!reply || typeof reply !== "object" || !("ok" in reply) || reply.ok !== true || !("records" in reply) || !Array.isArray(reply.records)) {
    throw new Error("Windows ACL validation failed");
  }
  return reply;
}
function queryNative(action, path, root) {
  if (process.platform !== "win32" || process.env.OMS_ACL_TRANSPORT === "oneshot" || !existsSync(workerPath)) {
    return queryPowerShell(action, path, root);
  }
  const reply = workerTransport.request({ action, path, root });
  if (!reply || typeof reply !== "object" || !("ok" in reply) || reply.ok !== true || !("records" in reply) || !Array.isArray(reply.records)) {
    throw new Error("Windows ACL validation failed");
  }
  return reply;
}
function inoMatches(nativeIno, ino) {
  try {
    return BigInt(nativeIno) === ino;
  } catch {
    return false;
  }
}
function createStoragePermissions(overrides = {}) {
  const dependencies = {
    platform: process.platform,
    getuid: () => process.getuid?.(),
    lstat: lstatSync,
    lstatBigint: (path) => lstatSync(path, { bigint: true }),
    native: queryNative,
    ...overrides
  };
  const preparedRoots = new Map;
  let scope;
  function pathKey(path) {
    return resolve(path).replaceAll("\\", "/").toLowerCase();
  }
  function sameIdentity(a, b) {
    return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs && a.isDirectory() === b.isDirectory() && a.isFile() === b.isFile();
  }
  function sameRevision(a, b) {
    return sameIdentity(a, b) && a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs && a.size === b.size && a.nlink === b.nlink;
  }
  function nativeRecords(action, path, treeRoot) {
    const reply = dependencies.native(action, resolve(path), treeRoot);
    if (reply.ok !== true || !Array.isArray(reply.records))
      throw new Error("Windows ACL validation failed");
    const root = pathKey(path);
    const records = new Map;
    for (const native of reply.records) {
      if (!native || typeof native.path !== "string" || typeof native.safe !== "boolean") {
        throw new Error("Windows ACL validation failed");
      }
      const key = pathKey(native.path);
      if (key !== root && !key.startsWith(`${root}/`))
        throw new Error("Windows ACL validation failed");
      if (records.has(key))
        throw new Error("Windows ACL validation failed");
      let stat;
      if (native.safe) {
        try {
          const current = dependencies.lstat(native.path);
          if (typeof native.ino === "string" && inoMatches(native.ino, dependencies.lstatBigint(native.path).ino) && native.directory === current.isDirectory() && typeof native.birthtimeMs === "number" && Math.abs(native.birthtimeMs - current.birthtimeMs) < 1 && typeof native.mtimeMs === "number" && Math.abs(native.mtimeMs - current.mtimeMs) < 1 && native.size === (current.isDirectory() ? 0 : current.size) && !current.isSymbolicLink() && (current.isDirectory() || current.isFile() && native.nlink === current.nlink && current.nlink >= 1))
            stat = current;
        } catch {}
      }
      records.set(key, { native, stat });
    }
    return records;
  }
  function scopedPermission(path, stat) {
    if (!scope)
      return;
    const key = pathKey(path);
    if (key !== scope.root && !key.startsWith(`${scope.root}/`))
      return;
    const record = scope.records.get(key);
    if (record && (!record.stat || !record.native.safe))
      return false;
    let ancestorPath = resolve(path);
    let ancestor = key;
    if (!record) {
      ancestorPath = dirname(ancestorPath);
      ancestor = pathKey(ancestorPath);
    }
    while (true) {
      const cached = scope.records.get(ancestor);
      if (!cached?.stat || !cached.native.safe)
        return false;
      const current = dependencies.lstat(ancestorPath);
      if (current.isSymbolicLink() || !sameIdentity(cached.stat, current))
        return false;
      if (ancestor === key) {
        if (!sameRevision(current, stat))
          return false;
        if (!current.isDirectory() && !sameRevision(cached.stat, current))
          return false;
      }
      if (ancestor === scope.root)
        return record ? true : undefined;
      ancestorPath = dirname(ancestorPath);
      const parent = pathKey(ancestorPath);
      if (parent === ancestor)
        return false;
      ancestor = parent;
    }
  }
  function hasPrivateStoragePermissions(path, stat) {
    if (dependencies.platform !== "win32") {
      const uid = dependencies.getuid();
      return (uid === undefined || stat.uid === uid) && (stat.mode & 63) === 0;
    }
    try {
      const scoped = scopedPermission(path, stat);
      if (scoped !== undefined)
        return scoped;
      const current = dependencies.lstat(path);
      if (current.isSymbolicLink() || !sameRevision(current, stat))
        return false;
      const key = pathKey(path);
      let treeRoot;
      for (const [root, prepared] of preparedRoots) {
        if ((key === root || key.startsWith(`${root}/`)) && (!treeRoot || root.length > treeRoot.length)) {
          treeRoot = prepared.path;
        }
      }
      const record = nativeRecords("check", path, treeRoot).get(key);
      if (record?.stat && scope && (key === scope.root || key.startsWith(`${scope.root}/`))) {
        scope.records.set(key, record);
      }
      return !!record?.stat && sameRevision(record.stat, stat);
    } catch {
      return false;
    }
  }
  function preparePrivateStorageDirectory(path) {
    if (dependencies.platform !== "win32")
      return;
    const before = dependencies.lstat(path);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error("OMS storage must be a private real directory");
    }
    const scoped = scopedPermission(path, before);
    if (scoped !== undefined) {
      if (!scoped)
        throw new Error("OMS storage must be a private real directory");
      return;
    }
    const key = pathKey(path);
    const previous = preparedRoots.get(key);
    const records = nativeRecords(previous && sameIdentity(previous.stat, before) ? "directory" : "prepare", path);
    const record = records.get(key);
    if (!record?.stat || !record.stat.isDirectory() || !sameIdentity(before, record.stat)) {
      throw new Error("OMS storage must be a private real directory");
    }
    preparedRoots.set(key, { path: resolve(path), stat: record.stat });
  }
  function invalidatePrivateStoragePermission(path) {
    if (!scope)
      return;
    const key = pathKey(path);
    const record = scope.records.get(key);
    if (!record?.native.safe || !record.stat?.isFile())
      return;
    try {
      const current = dependencies.lstat(path);
      if (!current.isSymbolicLink() && current.isFile() && sameIdentity(record.stat, current)) {
        scope.records.delete(key);
      }
    } catch {}
  }
  function trustCreatedFile(path) {
    if (!scope)
      return;
    const key = pathKey(path);
    if (!key.startsWith(`${scope.root}/`))
      return;
    scope.records.delete(key);
    try {
      const parentPath = dirname(resolve(path));
      const parent = scope.records.get(pathKey(parentPath));
      const parentNow = dependencies.lstat(parentPath);
      const current = dependencies.lstat(path);
      if (parent?.stat?.isDirectory() && parent.native.safe && !parentNow.isSymbolicLink() && sameIdentity(parent.stat, parentNow) && !current.isSymbolicLink() && current.isFile() && current.nlink === 1) {
        scope.records.set(key, { native: { path: resolve(path), safe: true }, stat: current });
      }
    } catch {}
  }
  function withPrivateStoragePermissions(root, action) {
    const previous = scope;
    const key = pathKey(root);
    const nested = previous !== undefined && (key === previous.root || key.startsWith(`${previous.root}/`));
    if (dependencies.platform === "win32" && !nested) {
      const before = dependencies.lstat(root);
      if (before.isSymbolicLink() || !before.isDirectory())
        throw new Error("OMS storage must be a private real directory");
      const prepared = preparedRoots.get(key);
      const records = nativeRecords(prepared && sameIdentity(prepared.stat, before) ? "tree" : "prepare", root);
      const directory = records.get(key);
      if (!directory?.stat?.isDirectory() || !sameIdentity(before, directory.stat)) {
        throw new Error("OMS storage must be a private real directory");
      }
      preparedRoots.set(key, { path: resolve(root), stat: directory.stat });
      scope = { root: key, records };
    }
    try {
      const result = action();
      if (result && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function") {
        throw new Error("Private storage permission scopes must be synchronous");
      }
      return result;
    } finally {
      scope = previous;
    }
  }
  return {
    preparePrivateStorageDirectory,
    hasPrivateStoragePermissions,
    invalidatePrivateStoragePermission,
    trustCreatedFile,
    withPrivateStoragePermissions
  };
}
var {
  preparePrivateStorageDirectory,
  hasPrivateStoragePermissions,
  invalidatePrivateStoragePermission,
  trustCreatedFile,
  withPrivateStoragePermissions
} = createStoragePermissions();

// extensions/prompt-stash.ts
var MAX_PROMPT_BYTES = 1024 * 1024;
var MAX_ENTRY_FILE_BYTES = 2 * 1024 * 1024;
var MAX_TOTAL_BYTES = 16 * 1024 * 1024;
var MAX_ENTRY_FILES = 256;
var MAX_ATTACHMENTS = 64;
var MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
var MAX_ENTRY_ATTACHMENT_BYTES = 128 * 1024 * 1024;
var MAX_ATTACHMENT_STORE_BYTES = 1024 * 1024 * 1024;
var ASSET_REF = /^sha256:([a-f0-9]{64})$/;
var ASSET_REF_TEXT = /sha256:([a-f0-9]{64})/g;
var ASSET_FILE = /^([a-f0-9]{64})(\.[a-z0-9][a-z0-9._-]*)?$/;
var ASSET_TEMP = /^\.[0-9a-f-]{36}\.(?:asset|link)\.tmp$/i;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var MAX_SESSION_ID_LENGTH = 128;
var MAX_SESSION_NAME_LENGTH = 512;
var MAX_WORKSPACE_NAME_LENGTH = 255;
var COLLAPSED_PASTE_TOKEN = /\[Paste #[1-9]\d*(?:,[^\]\n]*)?\]/;
var REPLACEMENT_WAIT = new Int32Array(new SharedArrayBuffer(4));
var GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
var STALE_TEMP = /^\.[0-9a-f-]{36}\.tmp$/i;
var STALE_TEMP_MS = 24 * 60 * 60 * 1000;
var ACTIVE_TEMP_MS = 60 * 1000;
var ORPHAN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
var QUOTA_ERROR = "OMS storage quota reached across all chats. Open the stash browser to manage it";
var ATTACHMENT_QUOTA_ERROR = "OMS attachment storage is full (1 GiB across all chats). Open the stash browser and delete stashes with images or large pastes";
var ENTRY_CACHE = new Map;
var LOCAL_TIMESTAMP_FORMATTERS = {
  "12-hour": new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }),
  "24-hour": new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23"
  })
};
var COMPACT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric"
});
var PLUGIN_NAME = "@hkay-dev/ohmystash";
var DEFAULT_CONFIG = {
  stashShortcut: "alt+s",
  editorCommand: "",
  browserShortcut: "alt+shift+s",
  showIcons: true,
  layout: "auto",
  maxBodyRows: 36,
  retentionDays: 0,
  timeFormat: "12-hour"
};
var pluginConfig = { ...DEFAULT_CONFIG };
var pluginEvents;
var ACTIVE_EDITORS = new WeakMap;

class EntryConflictError extends Error {
}

class StorageQuotaError extends Error {
}

class AttachmentCheckError extends Error {
  reason;
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}
function errorCode(cause) {
  return cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
}
function boundedNumber(value, fallback, min, max) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
var CONFIG_LOADS = new Map;
async function loadPluginConfig(cwd, fresh = false) {
  let load = fresh ? undefined : CONFIG_LOADS.get(cwd);
  if (!load) {
    load = readPluginConfig(cwd);
    CONFIG_LOADS.set(cwd, load);
  }
  return { ...await load };
}
async function readPluginConfig(cwd) {
  try {
    const raw = await getPluginSettings(PLUGIN_NAME, cwd);
    const layoutValue = raw["Browser layout"];
    const layout = layoutValue === "Side by side" ? "split" : layoutValue === "Stacked" ? "stacked" : layoutValue === "Compact" ? "compact" : "auto";
    const stashShortcut = raw["Stash shortcut"];
    const browserShortcut = raw["Browser shortcut"];
    const editorCommand = raw["Editor command"];
    const showIcons = raw["Show icons"];
    const timeFormat = raw["Time format"];
    return {
      editorCommand: typeof editorCommand === "string" ? editorCommand.trim() : DEFAULT_CONFIG.editorCommand,
      stashShortcut: typeof stashShortcut === "string" && stashShortcut.trim() ? stashShortcut.trim().toLowerCase() : DEFAULT_CONFIG.stashShortcut,
      browserShortcut: typeof browserShortcut === "string" && browserShortcut.trim() ? browserShortcut.trim().toLowerCase() : DEFAULT_CONFIG.browserShortcut,
      showIcons: typeof showIcons === "boolean" ? showIcons : DEFAULT_CONFIG.showIcons,
      layout,
      maxBodyRows: Math.round(boundedNumber(raw["Maximum body rows"], DEFAULT_CONFIG.maxBodyRows, 6, 72)),
      retentionDays: Math.round(boundedNumber(raw["Retention days"], DEFAULT_CONFIG.retentionDays, 0, 3650)),
      timeFormat: timeFormat === "24-hour clock" ? "24-hour" : "12-hour"
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function stashDir() {
  return join2(getAgentDir(), "prompt-stash");
}
function syncDirectory(path) {
  if (process.platform === "win32")
    return;
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncCreatedDirectoryParents(firstCreated, leaf) {
  const first = resolve2(firstCreated);
  let current = resolve2(leaf);
  while (true) {
    const parent = dirname2(current);
    syncDirectory(parent);
    if (current === first || parent === current)
      return;
    current = parent;
  }
}
function shellPath(path) {
  return `'${path.replaceAll("'", "'\\''")}'`;
}
function privateDirectoryError(label, dir, stat, cause) {
  if (stat.isSymbolicLink())
    return new Error(`${label} ${dir} is a symbolic link. Replace it with the real directory`);
  if (!stat.isDirectory()) {
    return new Error(`${label} ${dir} is not a directory. Move it aside so OMS can create the directory`);
  }
  if (process.platform === "win32") {
    const detail = cause instanceof Error ? ` (${cause.message})` : "";
    return new Error(`${label} ${dir} must be private to your account${detail}. Remove other accounts from its Security settings`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    return new Error(`${label} belongs to another account. Run: sudo chown -R "$(id -un)" ${shellPath(dir)}`);
  }
  return new Error(`${label} is shared with other accounts. Run: chmod 700 ${shellPath(dir)}`);
}
function privateFileFix(path, pattern = "") {
  return process.platform === "win32" ? `Remove other accounts from the Security settings of ${path}${pattern.replaceAll("/", "\\")}` : `Run: chmod 600 ${shellPath(path)}${pattern}`;
}
function checkedStashDir(create) {
  const dir = stashDir();
  const created = create ? mkdirSync(dir, { recursive: true, mode: 448 }) : undefined;
  if (created !== undefined)
    syncCreatedDirectoryParents(created, dir);
  const stat = lstatSync2(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || process.platform !== "win32" && !hasPrivateStoragePermissions(dir, stat)) {
    throw privateDirectoryError("OMS storage directory", dir, stat);
  }
  try {
    preparePrivateStorageDirectory(dir);
  } catch (error) {
    throw privateDirectoryError("OMS storage directory", dir, stat, error);
  }
  return dir;
}
function checkedAttachmentDir(create) {
  const root = checkedStashDir(create);
  const dir = join2(root, "attachments");
  const created = create ? mkdirSync(dir, { recursive: true, mode: 448 }) : undefined;
  if (created !== undefined)
    syncDirectory(root);
  const stat = lstatSync2(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || process.platform !== "win32" && !hasPrivateStoragePermissions(dir, stat)) {
    throw privateDirectoryError("OMS attachment directory", dir, stat);
  }
  try {
    preparePrivateStorageDirectory(dir);
  } catch (error) {
    throw privateDirectoryError("OMS attachment directory", dir, stat, error);
  }
  return dir;
}
function inStore(create, step, attachments = false) {
  const dir = stashDir();
  if (create) {
    const created = mkdirSync(dir, { recursive: true, mode: 448 });
    if (created !== undefined)
      syncCreatedDirectoryParents(created, dir);
  }
  const stat = lstatSync2(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw privateDirectoryError("OMS storage directory", dir, stat);
  if (create && attachments) {
    try {
      mkdirSync(join2(dir, "attachments"), { mode: 448 });
      syncDirectory(dir);
    } catch (error) {
      if (errorCode(error) !== "EEXIST")
        throw error;
    }
  }
  let started = false;
  try {
    return withPrivateStoragePermissions(dir, () => {
      started = true;
      return step(checkedStashDir(false));
    });
  } catch (error) {
    if (started)
      throw error;
    throw privateDirectoryError("OMS storage directory", dir, stat, error);
  }
}
function assetHash(data) {
  return new Bun.SHA256().update(data).digest("hex");
}
function assetPath(ref) {
  if (!ASSET_REF.test(ref))
    throw new Error("OMS attachment reference is invalid");
  return join2(checkedAttachmentDir(false), ref.slice("sha256:".length));
}
function readAsset(ref, byteLength) {
  if (byteLength < 0 || byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentCheckError("OMS attachment size is invalid", "damaged");
  }
  const path = assetPath(ref);
  const stat = lstatSync2(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== byteLength) {
    throw new AttachmentCheckError(`OMS attachment ${path} is damaged: it isn't a regular file of the expected size`, "damaged");
  }
  if (!hasPrivateStoragePermissions(path, stat)) {
    throw new AttachmentCheckError(`OMS attachment is shared with other accounts. ${privateFileFix(path)}`, "shared with other accounts");
  }
  const data = readFileSync(path);
  if (`sha256:${assetHash(data)}` !== ref) {
    throw new AttachmentCheckError(`OMS attachment ${path} is damaged: it failed its content hash check`, "damaged");
  }
  return data;
}
function touchAsset(path) {
  try {
    const now = new Date;
    utimesSync(path, now, now);
    invalidatePrivateStoragePermission(path);
  } catch {}
}
function linkDisplayPath(dir, finalPath, displayPath) {
  if (displayPath === finalPath)
    return;
  try {
    linkSync(finalPath, displayPath);
  } catch (error) {
    if (errorCode(error) !== "EEXIST")
      throw error;
    const canonical = lstatSync2(finalPath);
    const display = lstatSync2(displayPath);
    if (!display.isSymbolicLink() && display.isFile() && display.dev === canonical.dev && display.ino === canonical.ino) {
      return;
    }
    const tempLink = join2(dir, `.${randomUUID2()}.link.tmp`);
    linkSync(finalPath, tempLink);
    try {
      renameSync(tempLink, displayPath);
    } finally {
      try {
        unlinkSync(tempLink);
      } catch {}
    }
  }
  invalidatePrivateStoragePermission(finalPath);
  syncDirectory(dir);
}
function attachmentUsage(attachmentDir) {
  let bytes = 0;
  const handle = opendirSync(attachmentDir);
  try {
    for (let entry = handle.readSync();entry !== null; entry = handle.readSync()) {
      const asset = ASSET_FILE.exec(entry.name);
      if (!asset || asset[2] !== undefined)
        continue;
      try {
        const stat = lstatSync2(join2(attachmentDir, basename(entry.name)));
        if (stat.isFile())
          bytes += stat.size;
      } catch {}
    }
  } finally {
    handle.closeSync();
  }
  return bytes;
}
function reserveAttachmentSpace(attachmentDir, bytes) {
  if (attachmentUsage(attachmentDir) + bytes <= MAX_ATTACHMENT_STORE_BYTES)
    return;
  collectAttachmentGarbage(dirname2(attachmentDir));
  if (attachmentUsage(attachmentDir) + bytes > MAX_ATTACHMENT_STORE_BYTES) {
    throw new StorageQuotaError(ATTACHMENT_QUOTA_ERROR);
  }
}
function persistAsset(data, extension) {
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error("An OMS attachment exceeds the 64 MiB limit");
  }
  const dir = checkedAttachmentDir(true);
  const hash = assetHash(data);
  const ref = `sha256:${hash}`;
  const finalPath = join2(dir, hash);
  const displayPath = extension ? `${finalPath}.${extension}` : finalPath;
  let damaged = false;
  try {
    const existing = readAsset(ref, data.byteLength);
    if (!existing.equals(data))
      throw new Error("OMS attachment hash collision");
    touchAsset(finalPath);
    linkDisplayPath(dir, finalPath, displayPath);
    return ref;
  } catch (error) {
    if (error instanceof AttachmentCheckError)
      damaged = true;
    else if (errorCode(error) !== "ENOENT")
      throw error;
  }
  if (!damaged)
    reserveAttachmentSpace(dir, data.byteLength);
  const tempPath = join2(dir, `.${randomUUID2()}.asset.tmp`);
  let fd;
  let ownsTemp = false;
  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 384);
    ownsTemp = true;
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (damaged) {
      renameSync(tempPath, finalPath);
      ownsTemp = false;
      trustCreatedFile(finalPath);
    } else {
      try {
        linkSync(tempPath, finalPath);
      } catch (error) {
        if (errorCode(error) !== "EEXIST")
          throw error;
        const existing = readAsset(ref, data.byteLength);
        if (!existing.equals(data))
          throw new Error("OMS attachment hash collision");
      }
      unlinkSync(tempPath);
      ownsTemp = false;
    }
    linkDisplayPath(dir, finalPath, displayPath);
    syncDirectory(dir);
    return ref;
  } catch (error) {
    if (fd !== undefined)
      closeSync(fd);
    if (ownsTemp) {
      try {
        unlinkSync(tempPath);
        syncDirectory(dir);
      } catch {}
    }
    throw error;
  }
}
function attachmentDisplayPath(attachment) {
  const canonical = assetPath(attachment.ref);
  const extension = blobExtensionForImageMimeType(attachment.mimeType);
  if (!extension)
    return canonical;
  const displayPath = `${canonical}.${extension}`;
  try {
    const canonicalStat = lstatSync2(canonical);
    const displayStat = lstatSync2(displayPath);
    if (!displayStat.isSymbolicLink() && displayStat.isFile() && displayStat.dev === canonicalStat.dev && displayStat.ino === canonicalStat.ino) {
      return displayPath;
    }
  } catch {}
  return canonical;
}
function newestCandidateNames(dir) {
  const jsonNames = [];
  const preservedNames = [];
  const tempNames = [];
  let total = 0;
  const handle = opendirSync(dir);
  try {
    for (let entry = handle.readSync();entry !== null; entry = handle.readSync()) {
      if (entry.name.endsWith(".preserved.json")) {
        total += 1;
        preservedNames.push(entry.name);
        continue;
      }
      if (entry.name.endsWith(".json")) {
        total += 1;
        const insertAt = jsonNames.findIndex((name) => entry.name > name);
        if (insertAt === -1) {
          if (jsonNames.length < MAX_ENTRY_FILES)
            jsonNames.push(entry.name);
          continue;
        }
        jsonNames.splice(insertAt, 0, entry.name);
        if (jsonNames.length > MAX_ENTRY_FILES)
          jsonNames.pop();
        continue;
      }
      if (!STALE_TEMP.test(entry.name))
        continue;
      total += 1;
      tempNames.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  const names = [
    ...jsonNames.slice(0, MAX_ENTRY_FILES),
    ...preservedNames,
    ...tempNames
  ];
  return { names, skipped: Math.max(0, total - names.length), tempCount: tempNames.length };
}
function parseAttachments(value) {
  if (value === undefined)
    return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS)
    return;
  const attachments = [];
  let totalBytes = 0;
  let bodyCount = 0;
  for (const item of value) {
    if (typeof item !== "object" || item === null)
      return;
    const raw = item;
    const ref = raw.ref;
    const byteLength = raw.byteLength;
    if (typeof ref !== "string" || !ASSET_REF.test(ref) || typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_ATTACHMENT_BYTES) {
      return;
    }
    totalBytes += byteLength;
    if (totalBytes > MAX_ENTRY_ATTACHMENT_BYTES)
      return;
    if (raw.kind === "image") {
      if (typeof raw.mimeType !== "string" || !raw.mimeType.startsWith("image/") || raw.mimeType.length > 128 || raw.detail !== undefined && raw.detail !== "auto" && raw.detail !== "low" && raw.detail !== "high" && raw.detail !== "original") {
        return;
      }
      attachments.push({
        kind: "image",
        ref,
        byteLength,
        mimeType: raw.mimeType,
        ...raw.detail === undefined ? {} : { detail: raw.detail }
      });
      continue;
    }
    if (raw.kind !== "body" || bodyCount > 0 || typeof raw.charCount !== "number" || !Number.isSafeInteger(raw.charCount) || raw.charCount < 0 || typeof raw.lineCount !== "number" || !Number.isSafeInteger(raw.lineCount) || raw.lineCount < 1) {
      return;
    }
    bodyCount += 1;
    attachments.push({
      kind: "body",
      ref,
      byteLength,
      charCount: raw.charCount,
      lineCount: raw.lineCount
    });
  }
  return attachments;
}
function parseOrigin(value) {
  if (value === undefined)
    return;
  if (typeof value !== "object" || value === null)
    return null;
  const raw = value;
  if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0 || raw.sessionId.length > MAX_SESSION_ID_LENGTH) {
    return null;
  }
  if (raw.sessionName !== undefined && (typeof raw.sessionName !== "string" || raw.sessionName.length === 0 || raw.sessionName.length > MAX_SESSION_NAME_LENGTH)) {
    return null;
  }
  if (raw.workspaceName !== undefined && (typeof raw.workspaceName !== "string" || raw.workspaceName.length === 0 || raw.workspaceName.length > MAX_WORKSPACE_NAME_LENGTH)) {
    return null;
  }
  if (raw.sessionStartedAt !== undefined) {
    if (typeof raw.sessionStartedAt !== "string")
      return null;
    const startedAt = new Date(raw.sessionStartedAt);
    if (!Number.isFinite(startedAt.getTime()) || startedAt.toISOString() !== raw.sessionStartedAt) {
      return null;
    }
  }
  return {
    sessionId: raw.sessionId,
    ...raw.sessionName === undefined ? {} : { sessionName: raw.sessionName },
    ...raw.sessionStartedAt === undefined ? {} : { sessionStartedAt: raw.sessionStartedAt },
    ...raw.workspaceName === undefined ? {} : { workspaceName: raw.workspaceName }
  };
}
function parsePersistedEntry(text) {
  try {
    const parsed = JSON.parse(text);
    const inputMode = parsed.inputMode === undefined || parsed.inputMode === "normal" ? "normal" : parsed.inputMode === "queue" ? "queue" : undefined;
    const attachments = parseAttachments(parsed.attachments);
    const origin = parseOrigin(parsed.origin);
    const locked = parsed.locked === undefined ? false : parsed.locked;
    const preserved = parsed.preserved === undefined ? false : parsed.preserved;
    if (typeof parsed.id !== "string" || !UUID.test(parsed.id) || typeof parsed.text !== "string" || Buffer.byteLength(parsed.text, "utf8") > MAX_PROMPT_BYTES || inputMode === undefined || attachments === undefined || typeof locked !== "boolean" || typeof preserved !== "boolean" || typeof parsed.stashedAt !== "string") {
      return;
    }
    const parsedDate = new Date(parsed.stashedAt);
    if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString() !== parsed.stashedAt) {
      return;
    }
    const usedDate = typeof parsed.usedAt === "string" ? new Date(parsed.usedAt) : undefined;
    const usedAt = usedDate && Number.isFinite(usedDate.getTime()) && usedDate.toISOString() === parsed.usedAt ? parsed.usedAt : undefined;
    return {
      id: parsed.id,
      text: parsed.text,
      inputMode,
      stashedAt: parsed.stashedAt,
      origin: origin ?? undefined,
      stashedAtMs: parsedDate.getTime(),
      ...usedAt === undefined ? {} : { usedAt },
      attachments,
      locked,
      preserved
    };
  } catch {
    return;
  }
}
function isRecoverableTemp(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || !hasPrivateStoragePermissions(path, stat) || stat.size <= 0 || stat.size > MAX_ENTRY_FILE_BYTES) {
      return false;
    }
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size)
      return false;
    const entry = parsePersistedEntry(bytes.toString("utf8", 0, bytesRead));
    return entry !== undefined && basename(path) === `.${entry.id}.tmp`;
  } catch {
    return false;
  } finally {
    if (fd !== undefined)
      closeSync(fd);
  }
}
function cleanupStaleTemps(dir) {
  withPrivateStoragePermissions(dir, () => {
    const cutoff = Date.now() - STALE_TEMP_MS;
    let changed = false;
    const handle = opendirSync(dir);
    try {
      for (let entry = handle.readSync();entry !== null; entry = handle.readSync()) {
        if (!STALE_TEMP.test(entry.name))
          continue;
        const path = join2(dir, basename(entry.name));
        try {
          const stat = lstatSync2(path);
          if (stat.isSymbolicLink() || !stat.isFile() || !hasPrivateStoragePermissions(path, stat) || stat.mtimeMs > cutoff || isRecoverableTemp(path)) {
            continue;
          }
          renameSync(path, `${path}.orphan`);
          changed = true;
        } catch (error) {
          if (errorCode(error) !== "ENOENT")
            continue;
        }
      }
    } finally {
      handle.closeSync();
    }
    if (changed)
      syncDirectory(dir);
  });
}
function releaseTemp(path, inspected, setAside = false) {
  try {
    const current = lstatSync2(path);
    if (current.dev !== inspected.dev || current.ino !== inspected.ino)
      return;
    if (setAside)
      renameSync(path, `${path}.orphan`);
    else
      unlinkSync(path);
    syncDirectory(dirname2(path));
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      throw error;
  }
}
function storageUsage(dir, replacedName) {
  let count = 0;
  let bytes = 0;
  const handle = opendirSync(dir);
  try {
    for (let entry = handle.readSync();entry !== null; entry = handle.readSync()) {
      if (!entry.name.endsWith(".json") && !entry.name.endsWith(".tmp"))
        continue;
      if (entry.name === replacedName)
        continue;
      count += 1;
      try {
        const stat = lstatSync2(join2(dir, basename(entry.name)));
        if (!stat.isSymbolicLink() && stat.isFile())
          bytes += stat.size;
      } catch {}
      if (bytes > MAX_TOTAL_BYTES)
        break;
    }
  } finally {
    handle.closeSync();
  }
  return { count, bytes };
}
function loadEntries() {
  try {
    return inStore(false, (dir) => loadEntriesInDirectory(dir));
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      throw error;
    return { entries: [], omitted: { permissions: 0, damaged: 0, unsupported: 0, overLimit: 0 } };
  }
}
function setAsideDamaged(path, inspected) {
  try {
    const current = lstatSync2(path);
    if (current.dev !== inspected.dev || current.ino !== inspected.ino)
      return;
    renameSync(path, `${path}.invalid`);
    syncDirectory(dirname2(path));
  } catch {}
}
function isDamagedStashText(text) {
  try {
    const value = JSON.parse(text);
    return typeof value !== "object" || value === null || Array.isArray(value);
  } catch {
    return true;
  }
}
function loadEntriesInDirectory(dir) {
  const selection = newestCandidateNames(dir);
  const names = selection.names;
  const entries = [];
  const omitted = { permissions: 0, damaged: 0, unsupported: 0, overLimit: selection.skipped };
  let totalBytes = 0;
  const seenEntries = selection.tempCount > 0 ? new Map : undefined;
  let recovered = false;
  for (const fileName of names) {
    const path = join2(dir, basename(fileName));
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const stat = fstatSync(fd);
      const preservedFile = fileName.endsWith(".preserved.json");
      const recoveryFile = STALE_TEMP.test(fileName);
      const overflowProtected = preservedFile || recoveryFile;
      const abandoned = recoveryFile && Date.now() - stat.mtimeMs >= ACTIVE_TEMP_MS;
      if (recoveryFile && stat.isFile() && stat.size === 0) {
        if (abandoned)
          releaseTemp(path, stat);
        continue;
      }
      if (abandoned && stat.isFile() && hasPrivateStoragePermissions(path, stat) && !isRecoverableTemp(path)) {
        releaseTemp(path, stat, true);
        omitted.damaged += 1;
        continue;
      }
      if (!stat.isFile()) {
        omitted.unsupported += 1;
        continue;
      }
      if (!hasPrivateStoragePermissions(path, stat)) {
        omitted.permissions += 1;
        continue;
      }
      if (stat.size <= 0 || stat.size > MAX_ENTRY_FILE_BYTES) {
        if (recoveryFile) {
          omitted.unsupported += 1;
        } else {
          setAsideDamaged(path, stat);
          omitted.damaged += 1;
        }
        continue;
      }
      if (!overflowProtected && totalBytes + stat.size > MAX_TOTAL_BYTES) {
        omitted.overLimit += 1;
        continue;
      }
      if (!overflowProtected)
        totalBytes += stat.size;
      const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}:${stat.uid}:${pluginConfig.timeFormat}`;
      const cached = recoveryFile ? undefined : ENTRY_CACHE.get(fileName);
      if (cached?.fingerprint === fingerprint) {
        if (seenEntries?.has(cached.entry.id)) {
          continue;
        }
        seenEntries?.set(cached.entry.id, cached.entry);
        entries.push(cached.entry);
        continue;
      }
      const bytes = Buffer.allocUnsafe(stat.size + 1);
      const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) {
        omitted.unsupported += 1;
        continue;
      }
      const text = bytes.toString("utf8", 0, bytesRead);
      const persisted = parsePersistedEntry(text);
      if (persisted === undefined || recoveryFile && fileName !== `.${persisted.id}.tmp` || preservedFile && !persisted.preserved) {
        if (!recoveryFile && persisted === undefined && isDamagedStashText(text)) {
          setAsideDamaged(path, stat);
          omitted.damaged += 1;
        } else {
          omitted.unsupported += 1;
        }
        continue;
      }
      const revision = assetHash(bytes.subarray(0, bytesRead));
      const published = seenEntries?.get(persisted.id);
      if (published) {
        if (abandoned) {
          const differs = revision !== published.revision;
          if (differs && !saveOrphanCopy(dir, persisted, revision, stat))
            continue;
          releaseTemp(path, stat);
          recovered ||= differs;
        }
        continue;
      }
      const displayTimestamp = localTimestamp(persisted.stashedAt);
      const displayOrigin = stashOriginLabel(persisted.origin);
      const attachmentSearch = persisted.attachments.map((attachment) => attachment.kind === "image" ? `image ${attachment.mimeType}` : `paste ${attachment.lineCount} lines ${attachment.charCount} chars`).join(" ");
      const searchText = `${persisted.inputMode} ${persisted.locked ? "locked" : ""} ${persisted.preserved ? "preserved conflict" : ""} ${persisted.text}
${attachmentSearch}
${displayTimestamp}`;
      const originSearchText = `${displayOrigin} ${persisted.origin?.workspaceName ?? ""} ${persisted.origin?.sessionId ?? ""}`;
      const entry = {
        id: persisted.id,
        text: persisted.text,
        inputMode: persisted.inputMode,
        stashedAt: persisted.stashedAt,
        origin: persisted.origin,
        stashedAtMs: persisted.stashedAtMs,
        ...persisted.usedAt === undefined ? {} : { usedAt: persisted.usedAt },
        lastUsedMs: Math.max(persisted.stashedAtMs, persisted.usedAt === undefined ? 0 : Date.parse(persisted.usedAt)),
        fileName,
        revision,
        attachments: persisted.attachments,
        locked: persisted.locked,
        preserved: persisted.preserved,
        displayHeadline: headline(persisted.text),
        displayTimestamp,
        displayOrigin,
        lineCount: promptLineCount(persisted.text),
        searchText,
        searchTextAll: `${searchText}
${originSearchText}`
      };
      entries.push(entry);
      seenEntries?.set(entry.id, entry);
      if (!recoveryFile)
        ENTRY_CACHE.set(fileName, { fingerprint, entry });
    } catch (error) {
      const code = errorCode(error);
      if (code === "EACCES" || code === "EPERM")
        omitted.permissions += 1;
      else if (code !== "ENOENT")
        omitted.unsupported += 1;
    } finally {
      if (fd !== undefined)
        closeSync(fd);
    }
  }
  if (recovered) {
    const reloaded = withPrivateStoragePermissions(dir, () => loadEntriesInDirectory(dir));
    reloaded.omitted.damaged += omitted.damaged;
    return reloaded;
  }
  const candidateNames = new Set(names);
  for (const cachedName of ENTRY_CACHE.keys()) {
    if (!candidateNames.has(cachedName))
      ENTRY_CACHE.delete(cachedName);
  }
  entries.sort((a, b) => b.stashedAt.localeCompare(a.stashedAt));
  return { entries: pruneExpiredEntries(entries), omitted };
}
function saveEntry(text, inputMode, attachments, origin, locked = false, preserveOnQuota = false, identity) {
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error("Prompt is too large to stash safely");
  }
  const dir = checkedStashDir(true);
  cleanupStaleTemps(dir);
  const id = identity?.id ?? randomUUID2();
  const stashedAt = identity?.stashedAt ?? new Date().toISOString();
  const fileName = `${stashedAt.replaceAll(":", "-")}-${id}${preserveOnQuota ? ".preserved.json" : ".json"}`;
  const finalPath = join2(dir, fileName);
  const tempPath = join2(dir, `.${id}.tmp`);
  const payload = `${JSON.stringify({ id, text, inputMode, stashedAt, origin, attachments, locked, preserved: preserveOnQuota }, null, 2)}
`;
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (payloadBytes > MAX_ENTRY_FILE_BYTES) {
    throw new Error("Serialized prompt is too large to stash safely");
  }
  let fd;
  let ownsTemp = false;
  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 384);
    ownsTemp = true;
    writeFileSync(fd, payload, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const usage = storageUsage(dir);
    if (!preserveOnQuota && (usage.count > MAX_ENTRY_FILES || usage.bytes > MAX_TOTAL_BYTES)) {
      throw new StorageQuotaError(QUOTA_ERROR);
    }
    checkedStashDir(false);
    if (identity) {
      let linked = true;
      try {
        linkSync(tempPath, finalPath);
      } catch (error) {
        if (errorCode(error) !== "EEXIST")
          throw error;
        linked = false;
      }
      unlinkSync(tempPath);
      if (linked)
        trustCreatedFile(finalPath);
    } else {
      renameSync(tempPath, finalPath);
      trustCreatedFile(finalPath);
    }
    ownsTemp = false;
    syncDirectory(dir);
  } catch (error) {
    if (fd !== undefined)
      closeSync(fd);
    if (ownsTemp) {
      try {
        unlinkSync(tempPath);
        syncDirectory(dir);
      } catch {}
    }
    throw error;
  }
}
function saveOrphanCopy(dir, orphan, revision, stat) {
  const stashedAt = new Date(stat.mtimeMs).toISOString();
  const hash = assetHash(Buffer.from(`${revision}:${stashedAt}`));
  const variant = "89ab".charAt(Number.parseInt(hash.charAt(16), 16) % 4);
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  try {
    saveEntry(orphan.text, orphan.inputMode, orphan.attachments, orphan.origin, orphan.locked, true, { id, stashedAt });
    return true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST")
      throw error;
  }
  const tempPath = join2(dir, `.${id}.tmp`);
  try {
    const temp = lstatSync2(tempPath);
    if (Date.now() - temp.mtimeMs < ACTIVE_TEMP_MS || !isRecoverableTemp(tempPath))
      return false;
    try {
      linkSync(tempPath, join2(dir, `${stashedAt.replaceAll(":", "-")}-${id}.preserved.json`));
    } catch (error) {
      if (errorCode(error) !== "EEXIST")
        throw error;
    }
    releaseTemp(tempPath, temp);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return false;
    throw error;
  }
}
function openReplacementTemp(path) {
  const deadline = Date.now() + 500;
  while (true) {
    try {
      return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 384);
    } catch (error) {
      if (errorCode(error) !== "EEXIST")
        throw error;
      if (Date.now() >= deadline) {
        throw new EntryConflictError("Another process is updating this stash");
      }
      Atomics.wait(REPLACEMENT_WAIT, 0, 0, 2);
    }
  }
}
function publishRecovery(dir, entry) {
  const publishedName = `${entry.stashedAt.replaceAll(":", "-")}-${entry.id}${entry.preserved ? ".preserved.json" : ".json"}`;
  const sourcePath = join2(dir, basename(entry.fileName));
  try {
    if (Date.now() - lstatSync2(sourcePath).mtimeMs < ACTIVE_TEMP_MS) {
      throw new EntryConflictError("Another process is updating this stash");
    }
    linkSync(sourcePath, join2(dir, publishedName));
    unlinkSync(sourcePath);
    syncDirectory(dir);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new EntryConflictError("Stash was published while its recovery file was being changed");
    }
    if (errorCode(error) !== "ENOENT")
      throw error;
  }
  return publishedName;
}
function advancedUsedAt(current, entry) {
  const persisted = parsePersistedEntry(current.toString("utf8"));
  if (!persisted || persisted.usedAt === undefined || entry.usedAt !== undefined && persisted.usedAt <= entry.usedAt || persisted.id !== entry.id || persisted.text !== entry.text || persisted.inputMode !== entry.inputMode || persisted.stashedAt !== entry.stashedAt || persisted.locked !== entry.locked || persisted.preserved !== entry.preserved || JSON.stringify(persisted.attachments) !== JSON.stringify(entry.attachments) || JSON.stringify(persisted.origin) !== JSON.stringify(entry.origin)) {
    return;
  }
  return persisted.usedAt;
}
function replaceEntry(entry, text, attachments, locked, usedAt = entry.usedAt) {
  const dir = checkedStashDir(false);
  const publishedName = STALE_TEMP.test(entry.fileName) ? publishRecovery(dir, entry) : entry.preserved ? basename(entry.fileName) : `${entry.stashedAt.replaceAll(":", "-")}-${entry.id}.json`;
  const finalPath = join2(dir, publishedName);
  const tempPath = join2(dir, `.${entry.id}.tmp`);
  const serialize = (used) => `${JSON.stringify({
    id: entry.id,
    text,
    inputMode: entry.inputMode,
    stashedAt: entry.stashedAt,
    ...used === undefined ? {} : { usedAt: used },
    origin: entry.origin,
    attachments,
    locked,
    preserved: entry.preserved
  }, null, 2)}
`;
  if (Buffer.byteLength(serialize(usedAt), "utf8") > MAX_ENTRY_FILE_BYTES) {
    throw new Error("Edited prompt is too large to persist safely");
  }
  let fd;
  let ownsTemp = false;
  try {
    fd = openReplacementTemp(tempPath);
    ownsTemp = true;
    let current;
    try {
      current = readFileSync(finalPath);
    } catch {
      throw new EntryConflictError("Stash changed while it was being edited");
    }
    if (assetHash(current) !== entry.revision) {
      const advanced = advancedUsedAt(current, entry);
      if (advanced === undefined)
        throw new EntryConflictError("Stash changed while it was being edited");
      if (usedAt === undefined || advanced > usedAt)
        usedAt = advanced;
    }
    const payload = serialize(usedAt);
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (!entry.preserved && (text !== entry.text || attachments !== entry.attachments) && payloadBytes > current.length && storageUsage(dir, publishedName).bytes + payloadBytes > MAX_TOTAL_BYTES) {
      throw new StorageQuotaError(QUOTA_ERROR);
    }
    writeFileSync(fd, payload, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, finalPath);
    ownsTemp = false;
    trustCreatedFile(finalPath);
    syncDirectory(dir);
    ENTRY_CACHE.delete(entry.fileName);
    ENTRY_CACHE.delete(publishedName);
  } catch (error) {
    if (fd !== undefined)
      closeSync(fd);
    if (ownsTemp) {
      try {
        unlinkSync(tempPath);
        syncDirectory(dir);
      } catch {}
    }
    throw error;
  }
}
function setEntryLocked(entry, locked) {
  replaceEntry(entry, entry.text, entry.attachments, locked);
}
function markEntryUsed(entry) {
  if (entry.locked || entry.preserved || STALE_TEMP.test(entry.fileName))
    return;
  try {
    replaceEntry(entry, entry.text, entry.attachments, entry.locked, new Date().toISOString());
  } catch {}
}
function setEntryText(entry, editedText) {
  const images = entry.attachments.filter((attachment) => attachment.kind === "image");
  if (editedText.length === 0 && images.length === 0) {
    throw new Error("An attachment-free stash cannot be edited to an empty prompt");
  }
  const imageBytes = images.reduce((total, image) => total + image.byteLength, 0);
  const textBytes = Buffer.byteLength(editedText, "utf8");
  let text = editedText;
  let attachments = images;
  if (textBytes > MAX_PROMPT_BYTES) {
    if (images.length >= MAX_ATTACHMENTS) {
      throw new Error(`An OMS entry can contain at most ${MAX_ATTACHMENTS} attachments, including the large text body`);
    }
    if (textBytes > MAX_ATTACHMENT_BYTES || imageBytes + textBytes > MAX_ENTRY_ATTACHMENT_BYTES) {
      throw new Error("Edited prompt exceeds the file-backed attachment limit");
    }
    const ref = persistAsset(Buffer.from(editedText, "utf8"), "txt");
    const body = {
      kind: "body",
      ref,
      byteLength: textBytes,
      charCount: editedText.length,
      lineCount: promptLineCount(editedText)
    };
    text = `[Large pasted prompt \xB7 ${body.lineCount} lines \xB7 ${body.charCount} chars]`;
    attachments = [...images, body];
  }
  try {
    replaceEntry(entry, text, attachments, entry.locked);
    return "updated";
  } catch (error) {
    if (!(error instanceof EntryConflictError) && !(error instanceof StorageQuotaError))
      throw error;
    saveEntry(text, entry.inputMode, attachments, entry.origin, entry.locked, true);
    return error instanceof StorageQuotaError ? "quota-copy" : "conflict-copy";
  }
}
function releaseAlias(tempPath, path) {
  try {
    const temp = lstatSync2(tempPath, { bigint: true });
    const target = lstatSync2(path, { bigint: true });
    if (temp.isFile() && temp.dev === target.dev && temp.ino === target.ino) {
      unlinkSync(tempPath);
      invalidatePrivateStoragePermission(path);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      throw error;
  }
}
function removeEntry(entry, sync = true) {
  const dir = checkedStashDir(false);
  const fileName = STALE_TEMP.test(entry.fileName) ? publishRecovery(dir, entry) : basename(entry.fileName);
  const path = join2(dir, fileName);
  const tempPath = join2(dir, `.${entry.id}.tmp`);
  releaseAlias(tempPath, path);
  const fd = openReplacementTemp(tempPath);
  try {
    const stat = lstatSync2(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`OMS stash file ${path} isn't a regular file`);
    }
    if (!hasPrivateStoragePermissions(path, stat)) {
      throw new Error(`OMS stash file is shared with other accounts. ${privateFileFix(path)}`);
    }
    const bytes = readFileSync(path);
    const persisted = parsePersistedEntry(bytes.toString("utf8"));
    if (!persisted)
      throw new Error("Selected OMS entry changed and cannot be deleted safely");
    if (assetHash(bytes) !== entry.revision && advancedUsedAt(bytes, entry) === undefined) {
      throw new EntryConflictError("Stash changed after the browser loaded");
    }
    if (persisted.locked)
      throw new Error("Locked stashes must be unlocked before deletion");
    unlinkSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return false;
    throw error;
  } finally {
    closeSync(fd);
    try {
      unlinkSync(tempPath);
    } catch {}
    ENTRY_CACHE.delete(entry.fileName);
    ENTRY_CACHE.delete(fileName);
    if (sync)
      syncDirectory(dir);
  }
}
function removeEntries(entries) {
  const dir = checkedStashDir(false);
  return withPrivateStoragePermissions(dir, () => {
    let deleted = 0;
    for (const entry of entries) {
      try {
        if (removeEntry(entry, false))
          deleted += 1;
      } catch {}
    }
    syncDirectory(dir);
    collectAttachmentGarbage(dir);
    return deleted;
  });
}
function collectAttachmentGarbage(dir) {
  const attachmentDir = join2(dir, "attachments");
  try {
    const stat = lstatSync2(attachmentDir);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      return;
  } catch {
    return;
  }
  const now = Date.now();
  const referenced = new Set;
  let removedOrphan = false;
  const handle = opendirSync(dir);
  try {
    for (let entry = handle.readSync();entry !== null; entry = handle.readSync()) {
      const name = entry.name;
      const orphan = name.endsWith(".orphan");
      if (!orphan && !name.endsWith(".json") && !name.endsWith(".tmp") && !name.endsWith(".invalid"))
        continue;
      const path = join2(dir, basename(name));
      let text;
      try {
        const stat = lstatSync2(path);
        if (stat.isSymbolicLink() || !stat.isFile())
          continue;
        if (orphan && now - stat.mtimeMs >= ORPHAN_KEEP_MS) {
          unlinkSync(path);
          removedOrphan = true;
          continue;
        }
        if (stat.size > MAX_ENTRY_FILE_BYTES)
          continue;
        text = readFileSync(path, "latin1");
      } catch (error) {
        if (errorCode(error) === "ENOENT")
          continue;
        return;
      }
      for (const match of text.matchAll(ASSET_REF_TEXT))
        referenced.add(match[1]);
    }
  } finally {
    handle.closeSync();
  }
  if (removedOrphan)
    syncDirectory(dir);
  let removed = false;
  const assets = opendirSync(attachmentDir);
  try {
    for (let entry = assets.readSync();entry !== null; entry = assets.readSync()) {
      const asset = ASSET_FILE.exec(entry.name);
      if (asset ? referenced.has(asset[1]) : !ASSET_TEMP.test(entry.name))
        continue;
      const path = join2(attachmentDir, basename(entry.name));
      try {
        const stat = lstatSync2(path);
        if (stat.isDirectory() || now - stat.mtimeMs < (asset ? ACTIVE_TEMP_MS : STALE_TEMP_MS))
          continue;
        unlinkSync(path);
        removed = true;
      } catch {}
    }
  } finally {
    assets.closeSync();
  }
  if (removed)
    syncDirectory(attachmentDir);
}
function pruneExpiredEntries(entries) {
  if (pluginConfig.retentionDays <= 0)
    return entries;
  const cutoff = Date.now() - pluginConfig.retentionDays * 86400000;
  let removedNames;
  for (const entry of entries) {
    if (entry.locked || entry.preserved || STALE_TEMP.test(entry.fileName) || entry.lastUsedMs >= cutoff) {
      continue;
    }
    try {
      if (removeEntry(entry, false)) {
        (removedNames ??= new Set).add(entry.fileName);
      }
    } catch {}
  }
  if (!removedNames)
    return entries;
  const dir = checkedStashDir(false);
  syncDirectory(dir);
  collectAttachmentGarbage(dir);
  return entries.filter((entry) => !removedNames.has(entry.fileName));
}
function displayText(text) {
  return replaceTabs(text.replaceAll(`\r
`, `
`).replaceAll("\r", `
`)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "\uFFFD");
}
function headline(text) {
  const safe = displayText(text);
  let start = 0;
  while (start <= safe.length) {
    const newline = safe.indexOf(`
`, start);
    const end = newline === -1 ? safe.length : newline;
    const line = safe.slice(start, end).trim();
    if (line)
      return line.slice(0, 1024);
    if (newline === -1)
      break;
    start = newline + 1;
  }
  return "(empty prompt)";
}
function cutUtf16Limit(text, limit) {
  if (text.length <= limit)
    return text;
  let end = 0;
  for (const char of text) {
    if (end + char.length > limit)
      break;
    end += char.length;
  }
  return text.slice(0, end);
}
function currentStashOrigin(ctx) {
  const sessionId = ctx.sessionManager.getSessionId();
  if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) {
    throw new Error("OMP returned an invalid session ID");
  }
  const sessionName = cutUtf16Limit(ctx.sessionManager.getSessionName()?.trim() ?? "", MAX_SESSION_NAME_LENGTH);
  const headerTimestamp = ctx.sessionManager.getHeader()?.timestamp;
  const startedAt = headerTimestamp === undefined ? undefined : new Date(headerTimestamp);
  const sessionStartedAt = startedAt !== undefined && Number.isFinite(startedAt.getTime()) && startedAt.toISOString() === headerTimestamp ? headerTimestamp : undefined;
  const workspaceName = cutUtf16Limit(basename(resolve2(ctx.cwd)) || "/", MAX_WORKSPACE_NAME_LENGTH);
  return {
    sessionId,
    ...sessionName ? { sessionName } : {},
    ...sessionStartedAt ? { sessionStartedAt } : {},
    ...workspaceName ? { workspaceName } : {}
  };
}
function stashOriginLabel(origin) {
  if (!origin)
    return "Before chat tracking";
  const chat = origin.sessionName ? displayText(origin.sessionName) : "Untitled chat";
  const workspace = origin.workspaceName ? displayText(origin.workspaceName) : "";
  const shortId = origin.sessionId.slice(0, 8);
  return `${chat}${workspace ? ` \xB7 ${workspace}` : ""}${origin.sessionName ? "" : ` \xB7 ${shortId}`}`;
}
function stashOriginDetails(origin) {
  if (!origin)
    return "Chat: Before chat tracking";
  const chat = origin.sessionName ? displayText(origin.sessionName) : "Untitled chat";
  const workspace = origin.workspaceName ? displayText(origin.workspaceName) : "Unknown";
  const started = origin.sessionStartedAt ? localTimestamp(origin.sessionStartedAt) : "Unknown";
  return `Chat: ${chat} \xB7 Workspace: ${workspace} \xB7 Started: ${started} \xB7 Session: ${origin.sessionId.slice(0, 8)}`;
}
function isCurrentChat(entry, sessionId) {
  return entry.origin?.sessionId === sessionId;
}
function localTimestamp(iso) {
  const parts = LOCAL_TIMESTAMP_FORMATTERS[pluginConfig.timeFormat].formatToParts(new Date(iso));
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const dayPeriod = pluginConfig.timeFormat === "12-hour" ? ` ${value("dayPeriod")}` : "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}${dayPeriod}`;
}
function promptLineCount(text) {
  let count = 1;
  for (let index = 0;index < text.length; index += 1) {
    if (text[index] === `
` || text[index] === "\r" && text[index + 1] !== `
`)
      count += 1;
  }
  return count;
}
var NON_ASCII = /[^\x20-\x7e\n]/g;
function buildPreviewModel(text, width) {
  const safe = displayText(text);
  const safeWidth = Math.max(1, width);
  NON_ASCII.lastIndex = 0;
  let wide = NON_ASCII.exec(safe)?.index ?? -1;
  if (wide === -1) {
    let totalRows = 0;
    let lineStart = 0;
    for (let index = 0;index <= safe.length; index += 1) {
      if (index !== safe.length && safe[index] !== `
`)
        continue;
      totalRows += Math.max(1, Math.ceil((index - lineStart) / safeWidth));
      lineStart = index + 1;
    }
    return { kind: "ascii", text: safe, width: safeWidth, totalRows };
  }
  const rowStarts = [];
  const rowEnds = [];
  let lineStart = 0;
  while (true) {
    const newline = safe.indexOf(`
`, lineStart);
    const lineEnd = newline === -1 ? safe.length : newline;
    if (wide !== -1 && wide < lineStart) {
      NON_ASCII.lastIndex = lineStart;
      wide = NON_ASCII.exec(safe)?.index ?? -1;
    }
    if (wide === -1 || wide >= lineEnd) {
      if (lineEnd === lineStart) {
        rowStarts.push(lineStart);
        rowEnds.push(lineStart);
      }
      for (let start = lineStart;start < lineEnd; start += safeWidth) {
        rowStarts.push(start);
        rowEnds.push(Math.min(lineEnd, start + safeWidth));
      }
    } else {
      let rowStart = lineStart;
      let rowWidth = 0;
      for (const part of GRAPHEME_SEGMENTER.segment(safe.slice(lineStart, lineEnd))) {
        const graphemeWidth = visibleWidth2(part.segment);
        if (rowWidth > 0 && rowWidth + graphemeWidth > safeWidth) {
          rowStarts.push(rowStart);
          rowEnds.push(lineStart + part.index);
          rowStart = lineStart + part.index;
          rowWidth = 0;
        }
        rowWidth += graphemeWidth;
      }
      rowStarts.push(rowStart);
      rowEnds.push(lineEnd);
    }
    if (newline === -1)
      break;
    lineStart = newline + 1;
  }
  return { kind: "grapheme", text: safe, rowStarts, rowEnds, totalRows: rowStarts.length };
}
function previewPage(model, offset, count) {
  const page = [];
  if (model.kind === "grapheme") {
    const end = Math.min(model.totalRows, offset + count);
    for (let row = offset;row < end; row += 1) {
      page.push(model.text.slice(model.rowStarts[row], model.rowEnds[row]));
    }
    return page;
  }
  let globalRow = 0;
  let lineStart = 0;
  for (let index = 0;index <= model.text.length && page.length < count; index += 1) {
    if (index !== model.text.length && model.text[index] !== `
`)
      continue;
    const lineEnd = index;
    const rows = Math.max(1, Math.ceil((lineEnd - lineStart) / model.width));
    const firstRow = Math.max(0, offset - globalRow);
    if (globalRow + rows > offset) {
      for (let row = firstRow;row < rows && page.length < count; row += 1) {
        const start = lineStart + row * model.width;
        page.push(model.text.slice(start, Math.min(lineEnd, start + model.width)));
      }
    }
    globalRow += rows;
    lineStart = index + 1;
  }
  return page;
}
function parseEditorDraft(text) {
  if (text === "/queue")
    return { inputMode: "queue", text: "" };
  if (/^\/queue[ \t\n]/.test(text))
    return { inputMode: "queue", text: text.slice(7) };
  return { inputMode: "normal", text };
}
function activeEditor(ctx) {
  const editor = ACTIVE_EDITORS.get(ctx.sessionManager);
  return editor?.tui && editor.tui.getFocused() !== editor ? undefined : editor;
}
function hasEditorContent(ctx) {
  return parseEditorDraft(ctx.ui.getEditorText()).text.length > 0;
}
function installEditorBridge(ctx) {
  if (ctx.mode !== "tui")
    return;
  const sessionManager = ctx.sessionManager;
  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    const focused = tui.getFocused?.();
    const editor = focused instanceof CustomEditor ? focused : new CustomEditor(tui, theme, keybindings);
    if (editor === focused)
      editor.tui ??= tui;
    ACTIVE_EDITORS.set(sessionManager, editor);
    return editor;
  });
}
var VISION_MARKER = /\[(Image|Video) #([1-9]\d*)((?:,[^\]\n]*)?)\](?: attachment:\/\/(\2))?/g;
var ATTACHMENT_TOKEN = new RegExp(`\\[(?:Image|Video) #[1-9]\\d*(?:,[^\\]\\n]*)?\\]|(?:${Object.values(SYMBOL_PRESETS2).flatMap((preset) => [preset["chip.image"], preset["chip.video"], preset["chip.paste"]]).map((icon) => icon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}) #[1-9]\\d*`);
var IMAGE_EXTENSION_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg"
};
function normalizeBlobExtension(extension) {
  if (!extension)
    return;
  const normalized = extension.startsWith(".") ? extension.slice(1) : extension;
  if (normalized.length === 0 || normalized.length > 32)
    return;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized))
    return;
  return normalized.toLowerCase();
}
function blobExtensionForImageMimeType(mimeType) {
  if (!mimeType)
    return;
  const lower = mimeType.toLowerCase();
  const known = IMAGE_EXTENSION_BY_MIME[lower];
  if (known)
    return known;
  if (!lower.startsWith("image/"))
    return;
  const subtype = lower.slice("image/".length).split(";")[0]?.split("+")[0];
  return normalizeBlobExtension(subtype);
}
function readComposerDraft(ctx) {
  const editor = activeEditor(ctx);
  if (!editor) {
    const draft = parseEditorDraft(ctx.ui.getEditorText());
    if (ATTACHMENT_TOKEN.test(draft.text) || COLLAPSED_PASTE_TOKEN.test(draft.text)) {
      throw new Error("Restart OMP once so OhMyStash can attach to the native editor");
    }
    return { draft, images: [] };
  }
  const expanded = editor.getExpandedText();
  const keep = [...new Set(Array.from(expanded.matchAll(VISION_MARKER), (match) => Number(match[2])))].filter((n) => n <= editor.pendingImages.length).sort((a, b) => a - b);
  const draft = parseEditorDraft(expanded.replace(VISION_MARKER, (marker, kind, n, tail, ref) => {
    const index = keep.indexOf(Number(n)) + 1;
    if (index === 0)
      return marker;
    return `[${kind} #${index}${tail}]${ref === undefined ? "" : ` attachment://${index}`}`;
  }));
  const images = editor.pendingImages.filter((_, index) => keep.includes(index + 1));
  if (images.length > MAX_ATTACHMENTS) {
    throw new Error(`An OMS entry can contain at most ${MAX_ATTACHMENTS} attachments`);
  }
  return { draft, images };
}
function persistDraftAttachments({ draft: expandedDraft, images }) {
  let attachmentBytes = 0;
  const attachments = [];
  const stored = new Map;
  for (const image of images) {
    const data = Buffer.from(image.data, "base64");
    attachmentBytes += data.byteLength;
    if (attachmentBytes > MAX_ENTRY_ATTACHMENT_BYTES) {
      throw new Error("OMS attachments exceed the 128 MiB per-entry limit");
    }
    const extension = blobExtensionForImageMimeType(image.mimeType);
    const key = `${extension ?? ""}:${image.data}`;
    let ref = stored.get(key);
    if (ref === undefined) {
      ref = persistAsset(data, extension);
      stored.set(key, ref);
    }
    attachments.push({
      kind: "image",
      ref,
      byteLength: data.byteLength,
      mimeType: image.mimeType,
      ...image.detail === undefined ? {} : { detail: image.detail }
    });
  }
  const textBytes = Buffer.byteLength(expandedDraft.text, "utf8");
  if (textBytes <= MAX_PROMPT_BYTES) {
    return { ...expandedDraft, attachments };
  }
  attachmentBytes += textBytes;
  if (textBytes > MAX_ATTACHMENT_BYTES || attachmentBytes > MAX_ENTRY_ATTACHMENT_BYTES) {
    throw new Error("Large pasted prompt exceeds the 64 MiB text attachment limit");
  }
  if (attachments.length >= MAX_ATTACHMENTS) {
    throw new Error(`An OMS entry can contain at most ${MAX_ATTACHMENTS} attachments`);
  }
  const ref = persistAsset(Buffer.from(expandedDraft.text, "utf8"), "txt");
  attachments.push({
    kind: "body",
    ref,
    byteLength: textBytes,
    charCount: expandedDraft.text.length,
    lineCount: promptLineCount(expandedDraft.text)
  });
  return {
    inputMode: expandedDraft.inputMode,
    text: `[Large pasted prompt \xB7 ${promptLineCount(expandedDraft.text)} lines \xB7 ${expandedDraft.text.length} chars]`,
    attachments
  };
}
function resolveStoredAttachments(entry) {
  let body;
  const images = [];
  const imageLinks = [];
  const imageNumbers = [];
  const failures = [];
  let imageCount = 0;
  for (const attachment of entry.attachments) {
    if (attachment.kind === "image")
      imageCount += 1;
    let data;
    try {
      data = readAsset(attachment.ref, attachment.byteLength);
    } catch (error) {
      failures.push({
        label: attachment.kind === "image" ? `Image #${imageCount}` : "the large pasted text",
        reason: error instanceof AttachmentCheckError ? error.reason : errorCode(error) === "ENOENT" ? "missing" : error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    if (attachment.kind === "image") {
      images.push({
        type: "image",
        data: data.toString("base64"),
        mimeType: attachment.mimeType,
        ...attachment.detail === undefined ? {} : { detail: attachment.detail }
      });
      imageLinks.push(pathToFileURL(attachmentDisplayPath(attachment)).href);
      imageNumbers.push(imageCount);
    } else {
      if (body !== undefined)
        throw new Error("OMS entry contains multiple large text bodies");
      body = data.toString("utf8");
    }
  }
  return { body, images, imageLinks, imageNumbers, imageCount, failures };
}
function renumberImageMarkers(text, imageNumbers, imageCount) {
  if (imageNumbers.length === imageCount)
    return text;
  return text.replace(VISION_MARKER, (marker, kind, n, tail, ref) => {
    const number = Number(n);
    if (number > imageCount)
      return marker;
    const index = imageNumbers.indexOf(number) + 1;
    if (index === 0)
      return `[${kind} #${number} unavailable]`;
    return `[${kind} #${index}${tail}]${ref === undefined ? "" : ` attachment://${index}`}`;
  });
}
function describeFailures(failures) {
  const byReason = new Map;
  for (const { label, reason } of failures)
    byReason.set(reason, [...byReason.get(reason) ?? [], label]);
  return [...byReason].map(([reason, labels]) => `${labels.join(", ")} (${reason})`).join("; ");
}
function restoreIntoComposer(ctx, entry, options = {}) {
  lastSave = undefined;
  const prefix = options.forceQueue || entry.inputMode === "queue" ? "/queue " : "";
  const editor = activeEditor(ctx);
  if (!editor) {
    if (entry.attachments.length > 0) {
      throw new Error("Restart OMP once so OhMyStash can restore native attachments");
    }
    ctx.ui.setEditorText(`${prefix}${entry.text}`);
    return [];
  }
  const resolved = entry.attachments.length === 0 ? undefined : inStore(false, () => resolveStoredAttachments(entry));
  const images = resolved?.images ?? [];
  const text = resolved ? renumberImageMarkers(resolved.body ?? entry.text, resolved.imageNumbers, resolved.imageCount) : entry.text;
  const links = options.links === false ? undefined : resolved?.imageLinks ?? [];
  if (text.length > 1000 || text.includes(`
`)) {
    editor.setDraft(prefix, images);
    if (links) {
      editor.pendingImageLinks = links;
      editor.imageLinks = links;
    }
    editor.insertPaste(text);
  } else {
    editor.setDraft(`${prefix}${text}`, images);
    if (links) {
      editor.pendingImageLinks = links;
      editor.imageLinks = links;
    }
  }
  editor.tui?.requestRender();
  return resolved?.failures ?? [];
}
function submitQueuedEntry(ctx, entry) {
  const editor = activeEditor(ctx);
  if (!editor) {
    throw new Error("Restart OMP once so OhMyStash can submit queued stashes");
  }
  if (hasEditorContent(ctx)) {
    ctx.ui.notify("Stash or clear the current editor before submitting a queued stash", "warning");
    return "blocked";
  }
  const failures = restoreIntoComposer(ctx, entry, { forceQueue: true });
  markEntryUsed(entry);
  if (failures.length > 0) {
    ctx.ui.notify(`Inserted the queued draft without submitting it, because it's missing ${describeFailures(failures)}. The stash file is unchanged`, "warning");
    return "drafted";
  }
  editor.submit();
  return "submitted";
}
function editableEntryText(entry) {
  const body = entry.attachments.find((attachment) => attachment.kind === "body");
  return body ? inStore(false, () => readAsset(body.ref, body.byteLength).toString("utf8")) : entry.text;
}
async function editEntryText(ctx, entry, tui) {
  const original = editableEntryText(entry);
  const editorCommand = pluginConfig.editorCommand || getEditorCommand();
  let edited;
  if (editorCommand && tui) {
    tui.stop();
    try {
      edited = await openInEditor(editorCommand, original, {
        extension: ".md",
        trimTrailingNewline: !original.endsWith(`
`)
      });
    } finally {
      tui.start();
      tui.requestRender(true);
    }
  } else {
    edited = await ctx.ui.editor("Edit stashed prompt", original, undefined, { promptStyle: false });
  }
  if (edited === null || edited === undefined)
    return "cancelled";
  if (edited === original)
    return "unchanged";
  return { text: edited };
}
function clearEditorAfterStash(ctx, inputMode) {
  const editor = activeEditor(ctx);
  if (editor) {
    editor.setDraft(inputMode === "queue" ? "/queue " : "");
    editor.tui?.requestRender();
  } else {
    ctx.ui.setEditorText(inputMode === "queue" ? "/queue " : "");
  }
}
function compactAge(stashedAtMs, now) {
  const elapsed = Math.max(0, now - stashedAtMs);
  if (elapsed < 60000)
    return "now";
  if (elapsed < 3600000)
    return `${Math.floor(elapsed / 60000)}m`;
  if (elapsed < 86400000)
    return `${Math.floor(elapsed / 3600000)}h`;
  if (elapsed < 604800000)
    return `${Math.floor(elapsed / 86400000)}d`;
  return COMPACT_DATE_FORMATTER.format(stashedAtMs);
}
function filterStashEntries(entries, query, includeOrigin = false) {
  const normalized = query.trim().toLowerCase();
  if (!normalized)
    return entries;
  const literalMatches = entries.filter((entry) => {
    if (includeOrigin) {
      entry.searchTextAllLower ??= entry.searchTextAll.toLowerCase();
      return entry.searchTextAllLower.includes(normalized);
    }
    entry.searchTextLower ??= entry.searchText.toLowerCase();
    return entry.searchTextLower.includes(normalized);
  });
  return literalMatches.length > 0 ? literalMatches : fuzzyFilter2(entries, query, (entry) => {
    const text = includeOrigin ? entry.searchTextAll : entry.searchText;
    return text.length <= 4096 ? text : `${text.slice(0, 2048)}
${text.slice(-2047)}`;
  });
}
function showBrowser(ctx, live, initial, targets) {
  return ctx.ui.custom((tui, theme, _keybindings, done) => {
    const searchInput = new Input2;
    searchInput.prompt = "/";
    searchInput.setValue(initial.query);
    const currentSessionId = ctx.sessionManager.getSessionId();
    let entries = live.entries;
    let currentEntries = entries.filter((entry) => isCurrentChat(entry, currentSessionId));
    let scope = initial.scope;
    let scopedEntries = scope === "current" ? currentEntries : entries;
    let searching = false;
    let filteredEntries = filterStashEntries(scopedEntries, initial.query, scope === "all");
    const reselected = filteredEntries.findIndex((entry) => entry.id === initial.selectedId);
    let selected = reselected !== -1 ? reselected : Math.max(0, Math.min(initial.selectedIndex, filteredEntries.length - 1));
    let previewOffset = 0;
    let previewRows = 1;
    let previewCache;
    const selectedEntry = () => filteredEntries[selected];
    const applySearch = () => {
      filteredEntries = filterStashEntries(scopedEntries, searchInput.getValue(), scope === "all");
      selected = 0;
      previewOffset = 0;
      tui.requestRender();
    };
    const toggleScope = () => {
      scope = scope === "current" ? "all" : "current";
      scopedEntries = scope === "current" ? currentEntries : entries;
      applySearch();
    };
    const moveSelection = (delta) => {
      if (filteredEntries.length === 0)
        return;
      selected = Math.max(0, Math.min(filteredEntries.length - 1, selected + delta));
      previewOffset = 0;
      tui.requestRender();
    };
    const previewModel = (width) => {
      const entry = selectedEntry();
      if (!entry)
        return;
      if (previewCache?.entry !== entry || previewCache.width !== width) {
        previewCache = { entry, width, model: buildPreviewModel(entry.text, width) };
      }
      return previewCache.model;
    };
    live.changed = () => {
      if (live.entries.length === 0) {
        done(null);
        return;
      }
      const selectedId = selectedEntry()?.id;
      entries = live.entries;
      currentEntries = entries.filter((entry) => isCurrentChat(entry, currentSessionId));
      scopedEntries = scope === "current" ? currentEntries : entries;
      filteredEntries = filterStashEntries(scopedEntries, searchInput.getValue(), scope === "all");
      const index = filteredEntries.findIndex((entry) => entry.id === selectedId);
      if (index === -1)
        previewOffset = 0;
      selected = index !== -1 ? index : Math.max(0, Math.min(selected, filteredEntries.length - 1));
      tui.requestRender();
    };
    const exitSearch = (clear) => {
      searching = false;
      searchInput.focused = false;
      if (clear) {
        searchInput.setValue("");
        applySearch();
      } else {
        tui.requestRender();
      }
    };
    const browserState = () => ({
      query: searchInput.getValue(),
      scope,
      selectedId: selectedEntry()?.id,
      selectedIndex: selected
    });
    const finishSelected = (type) => {
      const entry = selectedEntry();
      if (entry)
        done({ type, entry, ...browserState() });
    };
    const finishDelete = () => {
      const entry = selectedEntry();
      if (entry)
        done({ type: "delete", entry, ...browserState() });
    };
    const finishDeleteAll = () => {
      if (scopedEntries.length > 0) {
        done({ type: "delete-all", entries: [...scopedEntries], ...browserState() });
      }
    };
    const finishToggleLock = () => {
      const entry = selectedEntry();
      if (entry)
        done({ type: "toggle-lock", entry, ...browserState() });
    };
    const finishEdit = () => {
      const entry = selectedEntry();
      if (entry)
        done({ type: "edit", entry, ...browserState(), tui });
    };
    return {
      dispose() {
        live.changed = undefined;
      },
      invalidate() {
        previewCache = undefined;
        searchInput.invalidate();
      },
      handleInput(data) {
        if (matchesKey2(data, Key2.ctrl("c"))) {
          done(null);
          return;
        }
        if (searching) {
          if (matchesKey2(data, Key2.escape)) {
            exitSearch(true);
          } else if (matchesKey2(data, Key2.enter)) {
            finishSelected("restore");
          } else if (matchesKey2(data, Key2.tab)) {
            exitSearch(false);
          } else if (matchesKey2(data, Key2.up)) {
            moveSelection(-1);
          } else if (matchesKey2(data, Key2.down)) {
            moveSelection(1);
          } else {
            const before = searchInput.getValue();
            searchInput.handleInput(data);
            if (searchInput.getValue() !== before)
              applySearch();
            else
              tui.requestRender();
          }
          return;
        }
        const key = extractPrintableText2(data);
        if (key === "/") {
          searching = true;
          searchInput.focused = true;
          tui.requestRender();
        } else if (key === "g") {
          toggleScope();
        } else if (matchesKey2(data, Key2.escape)) {
          if (searchInput.getValue())
            exitSearch(true);
          else
            done(null);
        } else if (matchesKey2(data, Key2.up)) {
          moveSelection(-1);
        } else if (matchesKey2(data, Key2.down)) {
          moveSelection(1);
        } else if (matchesKey2(data, Key2.home)) {
          moveSelection(-filteredEntries.length);
        } else if (matchesKey2(data, Key2.end)) {
          moveSelection(filteredEntries.length);
        } else if (matchesKey2(data, Key2.pageUp) || key === "[") {
          previewOffset = Math.max(0, previewOffset - previewRows);
          tui.requestRender();
        } else if (matchesKey2(data, Key2.pageDown) || key === "]") {
          previewOffset += previewRows;
          tui.requestRender();
        } else if (matchesKey2(data, Key2.enter) || key === "r") {
          finishSelected("restore");
        } else if (key === "p") {
          finishSelected("pop");
        } else if (key === "q") {
          finishSelected("queue");
        } else if (key === "Q") {
          finishSelected("submit-queue");
        } else if (key === "s" && targets.length > 0) {
          const entry = selectedEntry();
          if (entry)
            done({ type: "send", entry, targets, ...browserState() });
        } else if (key === "e") {
          finishEdit();
        } else if (key === "l") {
          finishToggleLock();
        } else if (key === "d" || matchesKey2(data, Key2.delete)) {
          finishDelete();
        } else if (key === "D") {
          finishDeleteAll();
        }
      },
      render(width) {
        const terminalRows = Math.max(1, tui.terminal.rows);
        const renderWidth = Math.max(1, width);
        const activeScopeLabel = scope === "current" ? "This chat" : "All chats";
        const entry = selectedEntry();
        const query = searchInput.getValue();
        const emptyCurrent = scope === "current" && currentEntries.length === 0 && !query && !searching;
        const showOrigin = scope === "all" && entry !== undefined;
        const renderNow = Date.now();
        const border = (text) => theme.fg("accent", text);
        const outerWidth = Math.max(1, renderWidth - 2);
        const searchIcon = theme.fg("accent", pluginConfig.showIcons ? extensionIcon("icon.search") : "/");
        const stashGlyph = pluginConfig.showIcons ? extensionIcon("icon.cache") : "";
        const draftGlyph = pluginConfig.showIcons ? extensionIcon("icon.file") : "[D]";
        const savedGlyph = pluginConfig.showIcons ? extensionIcon("icon.folder") : "";
        const queueGlyph = pluginConfig.showIcons ? extensionIcon("icon.output") : "[Q]";
        const timeGlyph = pluginConfig.showIcons ? extensionIcon("icon.time") : "";
        const labelWithIcon = (glyph, label) => glyph ? `${glyph} ${label}` : label;
        const keyHint = (key, label) => `${theme.fg("accent", key)} ${theme.fg("dim", label)}`;
        const promptFooter = entry ? (searching ? [keyHint("Enter", "Restore")] : [
          keyHint("Enter", "Restore"),
          keyHint("q", "Draft"),
          keyHint("Q", "Queue"),
          keyHint("l", entry.locked ? "Unlock" : "Lock"),
          keyHint("d", "Delete"),
          keyHint("e", "Edit"),
          keyHint("p", "Pop"),
          ...targets.length > 0 ? [keyHint("s", targets.length === 1 ? targets[0].label : "Send")] : []
        ]).join(theme.fg("dim", " ")) : "";
        const browserFooter = (searching ? [
          keyHint("Tab", "Select"),
          keyHint("Esc", "Clear"),
          keyHint("\u2191\u2193", "Navigate")
        ] : [
          keyHint("/", "Search"),
          keyHint("g", renderWidth >= 100 ? scope === "current" ? "Global" : "Current" : "Scope"),
          keyHint("\u2191\u2193", "Move"),
          keyHint("D", "Clear"),
          keyHint("[]", "Scroll"),
          keyHint("Esc", query ? "Clear" : "Close")
        ]).join(theme.fg("dim", " "));
        const renderSearchBar = (contentWidth) => {
          if (!query && !searching)
            return "";
          const count = `${filteredEntries.length}/${scopedEntries.length} matches`;
          const prefix = ` ${searchIcon} `;
          const suffix = ` ${theme.fg("dim", count)} `;
          const fieldWidth = Math.max(1, contentWidth - visibleWidth2(prefix) - visibleWidth2(suffix));
          const field = searching ? searchInput.render(fieldWidth)[0] ?? "/" : theme.fg("text", `/${query}`);
          const clipped = truncateToWidth2(field, fieldWidth);
          return `${prefix}${clipped}${" ".repeat(Math.max(0, fieldWidth - visibleWidth2(clipped)))}${suffix}`;
        };
        const ruleCell = (label, cellWidth) => {
          const text = ` ${label} `;
          const heading = theme.fg("accent", theme.bold(truncateToWidth2(text, cellWidth, "")));
          const rule = theme.fg("muted", "\u2500".repeat(Math.max(0, cellWidth - visibleWidth2(text))));
          return `${heading}${rule}`;
        };
        const listRow = (item, index, cellWidth) => {
          const isSelected = index === selected;
          const cursor = isSelected ? theme.fg("accent", ">") : " ";
          const mode = theme.fg(item.inputMode === "queue" ? "accent" : "muted", item.inputMode === "queue" ? queueGlyph : draftGlyph);
          const lock = item.locked ? theme.fg("warning", "[L]") : "";
          const conflict = item.preserved ? theme.fg("warning", "[C]") : "";
          const attachmentCount = item.attachments.length > 0 ? theme.fg("muted", `+${item.attachments.length}`) : "";
          const age = theme.fg("dim", compactAge(item.stashedAtMs, renderNow));
          const prefix = ` ${cursor} ${mode}${lock ? ` ${lock}` : ""}${conflict ? ` ${conflict}` : ""}${attachmentCount ? ` ${attachmentCount}` : ""} `;
          const originWidth = scope === "all" ? Math.min(18, Math.max(8, Math.floor(cellWidth * 0.28))) : 0;
          const origin = originWidth > 0 ? theme.fg("dim", truncateToWidth2(item.displayOrigin, originWidth)) : "";
          const suffix = `${origin ? `${origin} ` : ""}${age}`;
          const available = Math.max(1, cellWidth - visibleWidth2(prefix) - visibleWidth2(suffix) - 1);
          const summary = truncateToWidth2(item.displayHeadline, available);
          const styled = isSelected ? theme.fg("accent", theme.bold(summary)) : summary;
          const gap = " ".repeat(Math.max(1, cellWidth - visibleWidth2(prefix) - visibleWidth2(summary) - visibleWidth2(suffix)));
          return `${prefix}${styled}${gap}${suffix}`;
        };
        const useSplitLayout = pluginConfig.layout === "split" && renderWidth >= 72 || pluginConfig.layout === "auto" && renderWidth >= 92;
        if (pluginConfig.layout === "compact" || renderWidth < 32 || terminalRows < (useSplitLayout ? 12 : 13)) {
          const position = entry ? `${selected + 1}/${filteredEntries.length}` : `0/${filteredEntries.length}`;
          const mode = entry ? ` \xB7 ${entry.inputMode === "queue" ? queueGlyph : draftGlyph}${entry.locked ? " [L]" : ""}${entry.preserved ? " [C]" : ""}${entry.attachments.length > 0 ? ` +${entry.attachments.length}` : ""}` : "";
          const scopeLabel = scope === "current" ? "This chat" : entry?.displayOrigin ?? "All chats";
          const header = truncateToWidth2(searching ? searchInput.render(renderWidth)[0] ?? "/" : `Stash ${position} \xB7 ${scopeLabel}${mode}`, renderWidth, "");
          const searchLine = searching || query ? `${searchIcon} ${query ? `/${query}` : "/"}` : `${searchIcon} / search \xB7 g ${scope === "current" ? "all chats" : "this chat"}`;
          if (!entry) {
            const noCurrentStashes = emptyCurrent;
            return [
              theme.fg("accent", header),
              truncateToWidth2(searchLine, renderWidth, ""),
              theme.fg("muted", truncateToWidth2(noCurrentStashes ? "No stashes in this chat" : "No matching prompts", renderWidth, "")),
              ...noCurrentStashes && entries.length > 0 ? [theme.fg("dim", truncateToWidth2(`${entries.length} elsewhere \xB7 press g`, renderWidth, ""))] : []
            ].slice(0, terminalRows);
          }
          const visiblePreviewRows = Math.max(0, terminalRows - 2);
          previewRows = Math.max(1, visiblePreviewRows);
          const model = previewModel(renderWidth);
          const maxPreviewOffset = Math.max(0, model.totalRows - previewRows);
          previewOffset = Math.min(previewOffset, maxPreviewOffset);
          const page = previewPage(model, previewOffset, visiblePreviewRows);
          return [
            theme.fg("accent", header),
            truncateToWidth2(searchLine, renderWidth, ""),
            ...page.map((line) => truncateToWidth2(line, renderWidth, ""))
          ].slice(0, terminalRows);
        }
        const frame = createFrame(theme, renderWidth);
        if (useSplitLayout) {
          const promptFooterRows = entry ? 2 : 0;
          const availableBodyRows = Math.min(Math.max(4, pluginConfig.maxBodyRows - promptFooterRows), Math.max(4, terminalRows - 6 - promptFooterRows));
          const leftWidth = Math.min(44, Math.max(32, Math.floor((renderWidth - 3) * 0.38)));
          const rightWidth = Math.max(1, renderWidth - 3 - leftWidth);
          const leftContentWidth = Math.max(1, leftWidth - 1);
          const rightContentWidth = Math.max(1, rightWidth - 1);
          const model = entry ? previewModel(rightContentWidth) : undefined;
          const desiredListRows = Math.min(12, Math.max(4, filteredEntries.length));
          const headerRows = showOrigin ? 2 : 1;
          const desiredPreviewRows = model ? Math.min(pluginConfig.maxBodyRows, Math.max(4, model.totalRows + headerRows)) : 4;
          const bodyRows = Math.min(availableBodyRows, Math.max(desiredListRows, desiredPreviewRows));
          previewRows = Math.max(1, bodyRows - headerRows);
          if (model) {
            previewOffset = Math.min(previewOffset, Math.max(0, model.totalRows - previewRows));
          } else {
            previewOffset = 0;
          }
          const previewEnd = model ? Math.min(model.totalRows, previewOffset + previewRows) : 0;
          const page = model ? previewPage(model, previewOffset, previewRows) : [];
          const firstListIndex = Math.min(Math.max(0, selected - Math.floor(bodyRows / 2)), Math.max(0, filteredEntries.length - bodyRows));
          const position = entry ? `${selected + 1} of ${filteredEntries.length}` : `0 of ${filteredEntries.length}`;
          const previewLabel = labelWithIcon(entry?.inputMode === "queue" ? queueGlyph : draftGlyph, `Preview \xB7 ${entry?.inputMode === "queue" ? "Queue draft" : "Prompt draft"}`);
          const lines = [
            frame.top(labelWithIcon(stashGlyph, "OhMyStash")),
            frame.row(renderSearchBar(outerWidth)),
            `${border("\u251C")}${ruleCell(labelWithIcon(savedGlyph, `${activeScopeLabel} \xB7 ${position}`), leftWidth)}${border("\u252C")}${ruleCell(previewLabel, rightWidth)}${border("\u2524")}`
          ];
          for (let row = 0;row < bodyRows; row += 1) {
            const index = firstListIndex + row;
            const item = filteredEntries[index];
            const left = item ? listRow(item, index, leftContentWidth) : row === 0 && !entry ? theme.fg("muted", emptyCurrent ? "No stashes in this chat" : "No prompts match this search") : "";
            let right = "";
            if (entry && model) {
              if (row === 0) {
                const lineLabel = entry.lineCount === 1 ? "1 line" : `${entry.lineCount} lines`;
                right = theme.fg("muted", `${labelWithIcon(timeGlyph, entry.displayTimestamp)} \xB7 ${lineLabel} \xB7 ${entry.text.length} chars \xB7 ${entry.attachments.length} attachments${entry.locked ? " \xB7 locked" : ""}${entry.preserved ? " \xB7 conflict copy" : ""} \xB7 rows ${previewOffset + 1}-${previewEnd}/${model.totalRows}`);
              } else if (row === 1 && showOrigin) {
                right = theme.fg("dim", stashOriginDetails(entry.origin));
              } else if (row >= headerRows) {
                right = page[row - headerRows] ?? "";
              }
            } else if (row === 0) {
              right = theme.fg("muted", emptyCurrent && entries.length > 0 ? `${entries.length} stashes available in other chats` : "No prompt selected");
            } else if (row === 1) {
              right = theme.fg("dim", emptyCurrent ? "Press g to view all chats" : "Adjust or clear the search to continue");
            }
            lines.push(`${border("\u2502")}${fitToWidth(` ${left}`, leftWidth)}${border("\u2502")}${fitToWidth(` ${right}`, rightWidth)}${border("\u2502")}`);
          }
          if (entry) {
            lines.push(border(`\u251C${"\u2500".repeat(leftWidth)}\u253C${"\u2500".repeat(rightWidth)}\u2524`), `${border("\u2502")}${fitToWidth("", leftWidth)}${border("\u2502")}${fitToWidth(` ${promptFooter}`, rightWidth)}${border("\u2502")}`);
          }
          lines.push(border(`\u251C${"\u2500".repeat(leftWidth)}\u2534${"\u2500".repeat(rightWidth)}\u2524`), frame.row(` ${browserFooter}`), frame.bottom());
          return lines;
        }
        const promptFooterRows = entry ? 2 : 0;
        const availableBodyBudget = Math.min(Math.max(3, pluginConfig.maxBodyRows - promptFooterRows), Math.max(3, terminalRows - (showOrigin ? 8 : 7) - promptFooterRows));
        const contentWidth = Math.max(1, outerWidth - 1);
        const model = entry ? previewModel(contentWidth) : undefined;
        const desiredListRows = Math.min(6, Math.max(2, filteredEntries.length));
        const desiredPreviewRows = model ? Math.min(10, Math.max(3, model.totalRows)) : 3;
        const bodyBudget = Math.min(availableBodyBudget, desiredListRows + desiredPreviewRows);
        const listRows = Math.min(desiredListRows, Math.max(2, bodyBudget - 1));
        previewRows = Math.max(1, bodyBudget - listRows);
        if (model) {
          previewOffset = Math.min(previewOffset, Math.max(0, model.totalRows - previewRows));
        } else {
          previewOffset = 0;
        }
        const previewEnd = model ? Math.min(model.totalRows, previewOffset + previewRows) : 0;
        const page = model ? previewPage(model, previewOffset, previewRows) : [];
        const firstListIndex = Math.min(Math.max(0, selected - Math.floor(listRows / 2)), Math.max(0, filteredEntries.length - listRows));
        const position = entry ? `${selected + 1} of ${filteredEntries.length}` : `0 of ${filteredEntries.length}`;
        const previewLabel = labelWithIcon(entry?.inputMode === "queue" ? queueGlyph : draftGlyph, `Preview \xB7 ${entry?.inputMode === "queue" ? "Queue draft" : "Prompt draft"}`);
        const lines = [
          frame.top(labelWithIcon(stashGlyph, "OhMyStash")),
          frame.row(renderSearchBar(outerWidth)),
          frame.divider(labelWithIcon(savedGlyph, `${activeScopeLabel} \xB7 ${position}`))
        ];
        for (let row = 0;row < listRows; row += 1) {
          const index = firstListIndex + row;
          const item = filteredEntries[index];
          lines.push(frame.row(item ? listRow(item, index, outerWidth) : row === 0 && !entry ? theme.fg("muted", emptyCurrent ? "No stashes in this chat" : "No prompts match this search") : ""));
        }
        lines.push(frame.divider(previewLabel), frame.row(entry && model ? theme.fg("muted", ` ${labelWithIcon(timeGlyph, entry.displayTimestamp)} \xB7 ${entry.lineCount === 1 ? "1 line" : `${entry.lineCount} lines`} \xB7 ${entry.text.length} chars \xB7 ${entry.attachments.length} attachments${entry.locked ? " \xB7 locked" : ""}${entry.preserved ? " \xB7 conflict copy" : ""} \xB7 rows ${previewOffset + 1}-${previewEnd}/${model.totalRows}`) : theme.fg("muted", emptyCurrent && entries.length > 0 ? ` ${entries.length} stashes available in other chats \xB7 press g` : " Adjust or clear the search")));
        if (showOrigin) {
          lines.push(frame.row(` ${theme.fg("dim", stashOriginDetails(entry.origin))}`));
        }
        for (let row = 0;row < previewRows; row += 1) {
          lines.push(frame.row(` ${page[row] ?? ""}`));
        }
        if (entry) {
          lines.push(frame.divider(), frame.row(` ${promptFooter}`));
        }
        lines.push(frame.row(` ${browserFooter}`), frame.bottom());
        return lines;
      }
    };
  }, OVERLAY_OPTIONS);
}
function readStore(step) {
  return existsSync2(stashDir()) ? inStore(false, step) : step();
}
function loadEntriesForUi(ctx) {
  const { entries, omitted } = loadEntries();
  const dir = stashDir();
  const plural = (count, one, many) => count === 1 ? one : many;
  const warn = (count, message) => {
    if (count > 0)
      ctx.ui.notify(message, "warning");
  };
  const { permissions, damaged, unsupported, overLimit } = omitted;
  warn(permissions, `${permissions} OMS ${plural(permissions, "stash is", "stashes are")} hidden because ${plural(permissions, "its file is", "their files are")} shared with other accounts. ${privateFileFix(dir, "/*.json")}`);
  warn(damaged, `${damaged} damaged OMS stash ${plural(damaged, "file was", "files were")} set aside in ${dir} with an .invalid or .orphan suffix`);
  warn(unsupported, `${unsupported} OMS stash ${plural(unsupported, "file", "files")} in ${dir} couldn't be loaded. ${plural(unsupported, "It", "They")} may come from a newer OhMyStash`);
  warn(overLimit, `${overLimit} older OMS ${plural(overLimit, "stash is", "stashes are")} hidden because the store is over its limit of ${MAX_ENTRY_FILES} stashes or 16 MiB. Delete stashes you don't need to bring ${plural(overLimit, "it", "them")} back`);
  return entries;
}
function notifyRestored(ctx, summary, failures, detail) {
  if (failures.length === 0)
    ctx.ui.notify(`${summary}; ${detail}`, "info");
  else
    ctx.ui.notify(`${summary}, but couldn't restore ${describeFailures(failures)}`, "warning");
}
var DUPLICATE_SAVE_WINDOW_MS = 500;
var lastSave;
function saveKey(sessionId, composer) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([sessionId, composer.draft.inputMode, composer.draft.text]));
  for (const image of composer.images)
    hash.update(`\x00${image.mimeType}\x00${image.data}`);
  return hash.digest("hex");
}
async function stashCurrent(ctx) {
  const composer = readComposerDraft(ctx);
  if (composer.draft.text.length === 0 && composer.images.length === 0) {
    ctx.ui.notify("Nothing to stash", "info");
    return;
  }
  const origin = currentStashOrigin(ctx);
  const key = saveKey(origin.sessionId, composer);
  if (lastSave?.key === key && Date.now() - lastSave.at < DUPLICATE_SAVE_WINDOW_MS) {
    clearEditorAfterStash(ctx, composer.draft.inputMode);
    return;
  }
  const fileBacked = composer.images.length > 0 || Buffer.byteLength(composer.draft.text, "utf8") > MAX_PROMPT_BYTES;
  const { draft, repeated } = inStore(true, () => {
    const captured = fileBacked ? persistDraftAttachments(composer) : { ...composer.draft, attachments: [] };
    let newest;
    try {
      newest = loadEntries().entries.find((entry) => isCurrentChat(entry, origin.sessionId));
    } catch {}
    if (newest && !newest.preserved && !STALE_TEMP.test(newest.fileName) && newest.text === captured.text && newest.inputMode === captured.inputMode && JSON.stringify(newest.attachments) === JSON.stringify(captured.attachments)) {
      try {
        replaceEntry(newest, newest.text, newest.attachments, newest.locked, new Date().toISOString());
        return { draft: captured, repeated: true };
      } catch (error) {
        if (!(error instanceof EntryConflictError))
          throw error;
      }
    }
    saveEntry(captured.text, captured.inputMode, captured.attachments, origin);
    return { draft: captured, repeated: false };
  }, fileBacked);
  lastSave = { key, at: Date.now() };
  clearEditorAfterStash(ctx, draft.inputMode);
  const label = draft.inputMode === "queue" ? "Queue prompt" : "Prompt";
  if (repeated) {
    ctx.ui.notify(`${label} was already this chat's latest stash, so OMS kept that one`, "info");
    return;
  }
  const attachmentLabel = draft.attachments.length > 0 ? ` with ${draft.attachments.length} ${draft.attachments.length === 1 ? "attachment" : "attachments"}` : "";
  ctx.ui.notify(`${label} stashed (${promptLineCount(draft.text)} lines${attachmentLabel})`, "info");
}
async function restoreLatest(ctx, requestedMode) {
  if (!isMainTui(ctx))
    return;
  const current = parseEditorDraft(ctx.ui.getEditorText());
  if (hasEditorContent(ctx)) {
    ctx.ui.notify("Stash or clear the current editor before restoring a prompt", "warning");
    return;
  }
  const mode = requestedMode ?? (current.inputMode === "queue" ? "queue" : undefined);
  const restored = readStore(() => {
    const entries = loadEntriesForUi(ctx);
    const currentSessionId = ctx.sessionManager.getSessionId();
    const currentEntries = entries.filter((candidate) => isCurrentChat(candidate, currentSessionId));
    const entry = mode ? currentEntries.find((candidate) => candidate.inputMode === mode) : currentEntries[0];
    if (!entry)
      return { entries };
    const failures = restoreIntoComposer(ctx, entry);
    markEntryUsed(entry);
    return { entries, entry, failures };
  });
  const { entries, entry } = restored;
  if (!entry) {
    const label = mode === "queue" ? "No stashed queue prompts in this chat" : "No stashed prompts in this chat";
    const elsewhere = entries.length > 0 ? ` ${entries.length} ${entries.length === 1 ? "stash is" : "stashes are"} available in other chats. Open the browser to pick one` : "";
    ctx.ui.notify(`${label}.${elsewhere}`, "info");
    return;
  }
  const label = entry.inputMode === "queue" ? "Queue prompt" : "Prompt";
  notifyRestored(ctx, `${label} restored from ${entry.displayTimestamp}`, restored.failures ?? [], "restore never deletes stash files");
}
async function toggleStash(ctx) {
  if (!isMainTui(ctx))
    return;
  const draft = parseEditorDraft(ctx.ui.getEditorText());
  if (hasEditorContent(ctx)) {
    await stashCurrent(ctx);
    return;
  }
  await restoreLatest(ctx, draft.inputMode === "queue" ? "queue" : undefined);
}
var OPENING_BROWSERS = new WeakSet;
var STASH_WATCH_DEBOUNCE_MS = 150;
function watchEntries(live) {
  const key = (entries) => entries.map((entry) => `${entry.fileName}:${entry.revision}`).join(`
`);
  let timer;
  const refresh = () => {
    let next;
    try {
      next = readStore(() => loadEntries().entries);
    } catch {
      return;
    }
    if (key(next) === key(live.entries))
      return;
    live.entries = next;
    live.changed?.();
  };
  let watcher;
  try {
    watcher = watch(stashDir(), { persistent: false }, () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, STASH_WATCH_DEBOUNCE_MS);
    });
    watcher.on("error", () => watcher?.close());
  } catch {}
  return () => {
    clearTimeout(timer);
    watcher?.close();
  };
}
var BROWSER_WATCHES = new WeakMap;
async function browse(ctx) {
  if (!isMainTui(ctx) || OPENING_BROWSERS.has(ctx.ui))
    return;
  OPENING_BROWSERS.add(ctx.ui);
  queueMicrotask(() => OPENING_BROWSERS.delete(ctx.ui));
  let state = { query: "", scope: "all", selectedIndex: 0 };
  const live = { entries: readStore(() => loadEntriesForUi(ctx)) };
  if (live.entries.length === 0) {
    ctx.ui.notify("No stashed prompts", "info");
    return;
  }
  if (NATIVE_BROWSERS.has(ctx.ui))
    return;
  BROWSER_WATCHES.get(ctx.ui)?.();
  const stopWatching = watchEntries(live);
  BROWSER_WATCHES.set(ctx.ui, stopWatching);
  try {
    const host = collectNativeHost(pluginEvents);
    if (host) {
      NATIVE_BROWSERS.add(ctx.ui);
      try {
        if (await browseNative(ctx, host, live) === "done")
          return;
      } finally {
        NATIVE_BROWSERS.delete(ctx.ui);
      }
    }
    while (true) {
      if (live.entries.length === 0) {
        ctx.ui.notify("No stashed prompts", "info");
        return;
      }
      const action = await showBrowser(ctx, live, state, collectSendTargets(pluginEvents));
      if (!action) {
        if (live.entries.length === 0)
          ctx.ui.notify("No stashed prompts", "info");
        return;
      }
      const { query, scope, selectedId, selectedIndex } = action;
      state = { query, scope, selectedId, selectedIndex };
      try {
        const next = await runBrowserAction(ctx, action, live.entries);
        if (!next)
          return;
        live.entries = next;
      } catch (error) {
        if (!(error instanceof EntryConflictError))
          throw error;
        ctx.ui.notify("That stash changed in another session, so OMS reloaded the browser", "warning");
        live.entries = readStore(() => loadEntriesForUi(ctx));
      }
    }
  } finally {
    stopWatching();
    if (BROWSER_WATCHES.get(ctx.ui) === stopWatching)
      BROWSER_WATCHES.delete(ctx.ui);
  }
}
var NATIVE_BROWSERS = new WeakSet;
var NATIVE_BROWSER_ID = "ohmystash.browser";
var NATIVE_SEND_ID = "ohmystash.send";
var NATIVE_PREVIEW_CHARS = 4000;
var NATIVE_LINE_BYTES = 1e6;
var NATIVE_SEARCH_CHARS = 1000;
function nativeCut(text, max) {
  if (text.length <= max)
    return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max;
  return text.slice(0, end);
}
function nativeSearchText(entry) {
  const attachments = entry.attachments.map((attachment) => attachment.kind === "image" ? `image ${attachment.mimeType}` : `paste ${attachment.lineCount} lines ${attachment.charCount} chars`).join(" ");
  const flags = `${entry.inputMode} ${entry.locked ? "locked" : ""} ${entry.preserved ? "preserved conflict" : ""}`;
  const origin = `${entry.displayOrigin} ${entry.origin?.workspaceName ?? ""} ${entry.origin?.sessionId ?? ""}`;
  const text = nativeCut(entry.text, NATIVE_SEARCH_CHARS);
  return `${flags} ${text}
${attachments}
${entry.displayTimestamp}
${origin}`;
}
function nativeBrowserSpec(ctx, entries, state, targets) {
  const currentSessionId = ctx.sessionManager.getSessionId();
  const now = Date.now();
  const items = entries.map((entry) => {
    const marks = [];
    if (entry.locked)
      marks.push("lock.fill");
    if (entry.attachments.length > 0)
      marks.push("paperclip");
    if (entry.preserved)
      marks.push("exclamationmark.triangle");
    const tags = [];
    if (entry.locked)
      tags.push("locked");
    if (entry.inputMode === "queue")
      tags.push("queue");
    const attachments = entry.attachments.length;
    const meta = [
      entry.displayTimestamp,
      entry.lineCount === 1 ? "1 line" : `${entry.lineCount} lines`,
      `${entry.text.length} chars`,
      ...attachments > 0 ? [attachments === 1 ? "1 attachment" : `${attachments} attachments`] : [],
      ...entry.locked ? ["locked"] : []
    ].join(" \xB7 ");
    return {
      id: entry.id,
      title: entry.displayHeadline,
      subtitle: entry.displayOrigin,
      accessory: compactAge(entry.stashedAtMs, now),
      icon: entry.inputMode === "queue" ? "text.line.last.and.arrowtriangle.forward" : "text.bubble",
      marks,
      scopes: isCurrentChat(entry, currentSessionId) ? ["current", "all"] : ["all"],
      search: nativeSearchText(entry),
      tags,
      preview: { meta, text: nativeCut(entry.text, NATIVE_PREVIEW_CHARS) }
    };
  });
  return {
    id: NATIVE_BROWSER_ID,
    title: "OhMyStash",
    icon: "tray.full",
    placeholder: "Search stashes",
    query: state.query,
    selected: state.selectedId,
    scopes: [
      { id: "current", label: "This chat" },
      { id: "all", label: "All chats" }
    ],
    scope: state.scope,
    items,
    actions: [
      { id: "restore", label: "Restore", key: "enter", close: true },
      { id: "pop", label: "Pop", key: "shift+enter", close: true },
      { id: "queue", label: "Draft to queue", key: "alt+enter", close: true },
      { id: "submit-queue", label: "Submit queue", key: "cmd+shift+enter", when: "queue", close: true },
      ...targets.length > 0 ? [{ id: "send", label: targets.length === 1 ? targets[0].label : "Send", key: "cmd+enter", close: true }] : [],
      { id: "edit", label: "Edit", key: "cmd+e" },
      { id: "lock", label: "Lock", key: "cmd+l", unless: "locked" },
      { id: "unlock", label: "Unlock", key: "cmd+l", when: "locked" },
      {
        id: "delete",
        label: "Delete",
        key: "cmd+backspace",
        unless: "locked",
        confirm: {
          title: "Delete stashed prompt?",
          message: "Permanently delete \u201C{title}\u201D?",
          button: "Delete",
          destructive: true
        }
      },
      {
        id: "delete-all",
        label: "Delete unlocked",
        key: "cmd+shift+backspace",
        item: false,
        confirm: {
          title: "Delete unlocked stashes?",
          message: "Permanently delete every unlocked stash in this scope? Locked stashes are protected. This ignores the current search and cannot be undone.",
          button: "Delete",
          destructive: true
        }
      }
    ],
    empty: "No stashed prompts in this chat",
    preview: true
  };
}
async function browseNative(ctx, host, live) {
  let state = { query: "", scope: "all", selectedIndex: 0 };
  let first = true;
  const nextEvent = async (targets) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    let current;
    let shown = "";
    const list = (spec) => {
      const call = host.list(spec);
      current = call;
      shown = JSON.stringify(spec.items);
      call.then((event) => (call === current || event.type === "action") && resolve(event), (error) => call === current && reject(error));
    };
    list(nativeBrowserSpec(ctx, live.entries, state, targets));
    live.changed = () => {
      const spec = nativeBrowserSpec(ctx, live.entries, state, targets);
      if (JSON.stringify(spec.items) !== shown)
        list({ ...spec, query: undefined, selected: undefined, scope: undefined });
    };
    try {
      return await promise;
    } finally {
      live.changed = undefined;
    }
  };
  const ui = {
    confirmed: true,
    async editText(entry) {
      const viaTui = async () => {
        await host.close(NATIVE_BROWSER_ID);
        return editEntryText(ctx, entry, ACTIVE_EDITORS.get(ctx.sessionManager)?.tui);
      };
      if (pluginConfig.editorCommand)
        return viaTui();
      const original = editableEntryText(entry);
      const spec = { id: "ohmystash.edit", title: "Edit stashed prompt", text: original, save: "Save" };
      if (Buffer.byteLength(JSON.stringify(spec)) > NATIVE_LINE_BYTES)
        return viaTui();
      let edited;
      try {
        edited = await host.edit(spec);
      } catch {
        return viaTui();
      }
      if (edited === undefined)
        return "cancelled";
      if (edited === original)
        return "unchanged";
      return { text: edited };
    },
    async pickTarget(labels) {
      let cancelled = false;
      try {
        const event = await host.list({
          id: NATIVE_SEND_ID,
          title: "Send stash to",
          items: labels.map((label, index) => ({ id: String(index), title: label })),
          actions: [{ id: "send", label: "Send", key: "enter", close: true }]
        });
        if (event.type !== "action" || event.item === undefined) {
          cancelled = true;
          return;
        }
        return labels[Number(event.item)];
      } finally {
        if (!cancelled)
          await host.close(NATIVE_SEND_ID);
      }
    }
  };
  try {
    while (true) {
      if (live.entries.length === 0) {
        if (first)
          ctx.ui.notify("No stashed prompts", "info");
        return "done";
      }
      const targets = collectSendTargets(pluginEvents);
      let event;
      try {
        event = await nextEvent(targets);
      } catch {
        if (first)
          return "fallback";
        return "done";
      }
      first = false;
      const scope = event.scope === "current" || event.scope === "all" ? event.scope : state.scope;
      state = { query: event.query, scope, selectedId: event.type === "action" ? event.item : state.selectedId, selectedIndex: 0 };
      if (event.type === "cancel")
        return "done";
      const action = nativeBrowserAction(ctx, event.action, event.item, live.entries, state, targets);
      if (!action)
        continue;
      try {
        const next = await runBrowserAction(ctx, action, live.entries, ui);
        if (!next)
          return "done";
        live.entries = next;
      } catch (error) {
        if (!(error instanceof EntryConflictError))
          throw error;
        ctx.ui.notify("That stash changed in another session, so OMS reloaded the browser", "warning");
        live.entries = readStore(() => loadEntriesForUi(ctx));
      }
    }
  } finally {
    await host.close(NATIVE_BROWSER_ID);
  }
}
function nativeBrowserAction(ctx, id, itemId, entries, state, targets) {
  if (id === "delete-all") {
    const currentSessionId = ctx.sessionManager.getSessionId();
    const scoped = state.scope === "current" ? entries.filter((entry) => isCurrentChat(entry, currentSessionId)) : entries;
    return scoped.length > 0 ? { type: "delete-all", entries: [...scoped], ...state } : undefined;
  }
  const entry = entries.find((candidate) => candidate.id === itemId);
  if (!entry)
    return;
  switch (id) {
    case "restore":
    case "pop":
    case "queue":
    case "submit-queue":
    case "edit":
    case "delete":
      return { type: id, entry, ...state };
    case "lock":
    case "unlock":
      return { type: "toggle-lock", entry, ...state };
    case "send":
      return targets.length > 0 ? { type: "send", entry, targets, ...state } : undefined;
    default:
      return;
  }
}
async function runBrowserAction(ctx, action, entries, ui = {}) {
  const thenReload = (step) => readStore(() => {
    const value = step();
    return { value, next: loadEntriesForUi(ctx) };
  });
  if (action.type === "edit") {
    const edit = ui.editText ? await ui.editText(action.entry) : await editEntryText(ctx, action.entry, action.tui);
    if (typeof edit === "string") {
      ctx.ui.notify(edit === "unchanged" ? "Stashed prompt unchanged" : "Stashed prompt edit cancelled", "info");
      return entries;
    }
    const { value: result, next } = thenReload(() => setEntryText(action.entry, edit.text));
    ctx.ui.notify(result === "updated" ? "Stashed prompt updated" : result === "conflict-copy" ? "Stash changed concurrently; edited text was preserved as a new stash" : "OMS storage quota reached; edited text was preserved as a new stash", result === "quota-copy" ? "warning" : "info");
    return next;
  }
  if (action.type === "toggle-lock") {
    const { next } = thenReload(() => setEntryLocked(action.entry, !action.entry.locked));
    ctx.ui.notify(action.entry.locked ? "Stash unlocked" : "Stash locked", "info");
    return next;
  }
  if (action.type === "submit-queue") {
    const { value: outcome, next } = thenReload(() => submitQueuedEntry(ctx, action.entry));
    return outcome === "drafted" ? undefined : next;
  }
  if (action.type === "send") {
    const { entry, targets } = action;
    const label = targets.length === 1 ? targets[0].label : ui.pickTarget ? await ui.pickTarget(targets.map((target) => target.label)) : await selectOption(ctx, "Send stash to", targets.map((target) => target.label), undefined, {
      icons: pluginConfig.showIcons
    });
    const target = targets.find((candidate) => candidate.label === label);
    if (!target)
      return entries;
    const prompt = readStore(() => {
      const text = editableEntryText(entry);
      markEntryUsed(entry);
      return { text, images: entry.attachments.filter((attachment) => attachment.kind === "image").length };
    });
    await target.send(prompt, ctx);
    return;
  }
  if (action.type === "delete") {
    if (action.entry.locked) {
      ctx.ui.notify("Unlock this stash before deleting it", "warning");
      return entries;
    }
    const confirmed = ui.confirmed || await ctx.ui.confirm("Delete stashed prompt?", `Permanently delete \u201C${truncateToWidth2(action.entry.displayHeadline, 80)}\u201D from ${action.entry.displayTimestamp}${action.scope === "all" ? ` \xB7 ${action.entry.displayOrigin}` : ""}?`, { initialIndex: 1 });
    if (!confirmed)
      return entries;
    const { value: deleted, next } = thenReload(() => {
      const removed = removeEntry(action.entry);
      collectAttachmentGarbage(checkedStashDir(false));
      return removed;
    });
    ctx.ui.notify(deleted ? "Deleted stashed prompt" : "Stash entry was already deleted", "info");
    return next;
  }
  if (action.type === "delete-all") {
    const deletable = action.entries.filter((entry) => !entry.locked);
    const locked = action.entries.length - deletable.length;
    if (deletable.length === 0) {
      ctx.ui.notify("Every stash is locked; nothing was deleted", "warning");
      return entries;
    }
    const count = deletable.length;
    const scopeLabel = action.scope === "current" ? "from this chat" : "across all chats";
    const confirmed = ui.confirmed || await ctx.ui.confirm(`Delete unlocked stashes ${scopeLabel}?`, `Permanently delete ${count} unlocked stashed ${count === 1 ? "prompt" : "prompts"} ${scopeLabel}? ${locked} locked ${locked === 1 ? "stash is" : "stashes are"} protected. This ignores the current search and cannot be undone.`, { initialIndex: 1 });
    if (!confirmed)
      return entries;
    const { value: deleted, next } = thenReload(() => removeEntries(deletable));
    ctx.ui.notify(deleted === count ? `Deleted ${deleted} unlocked stashed ${deleted === 1 ? "prompt" : "prompts"}; ${locked} locked protected` : `Deleted ${deleted} of ${count} unlocked stashed prompts; ${locked} locked protected`, "info");
    return next;
  }
  if (hasEditorContent(ctx)) {
    ctx.ui.notify("Stash or clear the current editor before restoring a prompt", "warning");
    return entries;
  }
  const { entry } = action;
  const pop = action.type === "pop";
  const { failures, outcome } = readStore(() => {
    const restored = restoreIntoComposer(ctx, entry, { forceQueue: action.type === "queue", links: !pop });
    if (!pop || entry.locked || restored.length > 0) {
      markEntryUsed(entry);
      return { failures: restored, outcome: "kept" };
    }
    try {
      removeEntry(entry);
    } catch (error) {
      if (!(error instanceof EntryConflictError))
        throw error;
      return { failures: restored, outcome: "changed" };
    }
    collectAttachmentGarbage(checkedStashDir(false));
    return { failures: restored, outcome: "deleted" };
  });
  if (action.type === "queue") {
    notifyRestored(ctx, `Inserted queued draft from ${entry.displayTimestamp}`, failures, "stash file retained");
  } else if (!pop) {
    notifyRestored(ctx, `Restored prompt from ${entry.displayTimestamp}`, failures, "restore never deletes stash files");
  } else if (outcome === "deleted") {
    ctx.ui.notify(`Popped prompt from ${entry.displayTimestamp}; the stash is deleted`, "info");
  } else if (outcome === "changed") {
    ctx.ui.notify(`Restored prompt from ${entry.displayTimestamp}, but kept the stash because it changed in another session`, "warning");
  } else {
    notifyRestored(ctx, `Restored prompt from ${entry.displayTimestamp}`, failures, "locked stashes stay after a pop");
  }
  return;
}
async function run(ctx, action) {
  try {
    await action();
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = truncateToWidth2(displayText(raw).replaceAll(`
`, " "), 320);
    ctx.ui.notify(`OMS failed: ${message}`, "error");
  }
}
function isMainTui(ctx) {
  return ctx.agent.kind === "main" && ctx.mode === "tui";
}
var startupScan = Promise.resolve();
function startupScanSettled() {
  return startupScan;
}
async function promptStash(pi) {
  const config = await loadPluginConfig(process.cwd());
  const startSession = async (ctx) => {
    if (!isMainTui(ctx))
      return;
    pluginEvents = pi.events;
    pluginConfig = await loadPluginConfig(ctx.cwd, true);
    installEditorBridge(ctx);
    warmStoragePermissions();
    if (pluginConfig.retentionDays > 0) {
      startupScan = new Promise((done) => {
        setTimeout(() => void run(ctx, async () => void loadEntries()).finally(done), 0);
      });
    }
  };
  pi.on("session_start", (_event, ctx) => startSession(ctx));
  pi.on("session_switch", (_event, ctx) => startSession(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (isMainTui(ctx))
      stopStoragePermissions();
  });
  if (config.stashShortcut !== "none") {
    pi.registerShortcut(config.stashShortcut, {
      description: "Stash current prompt, or restore this chat's latest stash when the editor is empty",
      handler: async (ctx) => run(ctx, () => toggleStash(ctx))
    });
  }
  if (config.browserShortcut !== "none") {
    pi.registerShortcut(config.browserShortcut, {
      description: "Browse every chat's stashes, with this chat one key away",
      handler: async (ctx) => run(ctx, () => browse(ctx))
    });
  }
  pi.registerCommand("stash", {
    description: "Browse stashes from this chat or all chats. Restore uses this chat",
    handler: async (args, ctx) => run(ctx, async () => {
      const command = args.trim();
      if (ctx.agent.kind === "main" && ctx.mode !== "tui" && (command === "" || command === "restore")) {
        ctx.ui.notify("/stash needs the OMP terminal UI. Pick stashes from Harrier's Stash pane instead", "warning");
        return;
      }
      if (command === "")
        return browse(ctx);
      if (command === "restore")
        return restoreLatest(ctx);
      ctx.ui.notify("Usage: /stash or /stash restore", "warning");
    })
  });
}
export {
  cutUtf16Limit,
  promptStash as default,
  startupScanSettled
};
