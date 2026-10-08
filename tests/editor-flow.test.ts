import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components";
import type { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import type * as Tui from "@oh-my-pi/pi-tui";
import { blobExtensionForImageMimeType } from "@oh-my-pi/pi-tui/prompt/image-format";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import type * as PopupUi from "../extensions/ui";

type Handler = (ctx: ExtensionContext) => Promise<void> | void;
type StoredEntry = { text: string; attachments: unknown[] };

const agentDir = mkdtempSync(join(tmpdir(), "oms-editor-flow-"));
const stashDir = join(agentDir, "prompt-stash");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousConfigDir = process.env.PI_CONFIG_DIR;
const EDITOR_THEME = { symbols: {}, borderColor: (text: string) => text };
const BROWSER_THEME = {
  isLight: false,
  getFgAnsi: () => "\u001b[39m",
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  symbol: (name: string) => name,
};

let Editor: typeof CustomEditor;
let getKeybindings: typeof Tui.getKeybindings;
let UiController: typeof ExtensionUiController;
let OVERLAY_OPTIONS: typeof PopupUi.OVERLAY_OPTIONS;
let selectOption: typeof PopupUi.selectOption;
let sessionStart: (event: unknown, ctx: ExtensionContext) => Promise<void>;
let stashCommand: (args: string, ctx: ExtensionContext) => Promise<void> | void;
// Registration order: the stash shortcut, then the browser shortcut.
const shortcuts: Handler[] = [];
// Fixtures predate anything the tests stash, so "restore latest" picks fresh stashes first.
let fixtureClock = Date.now() - 3_600_000;

function image(label: string) {
  return { type: "image" as const, data: Buffer.from(label).toString("base64"), mimeType: "image/png" };
}

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(join(agentDir, ".omp"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(agentDir, ".omp", "plugin-overrides.json"),
    JSON.stringify({ settings: { "@hkay-dev/ohmystash": settings } }),
    { mode: 0o600 },
  );
}

function writeStash(sessionId: string, text: string): string {
  fixtureClock += 1;
  const id = randomUUID();
  const stashedAt = new Date(fixtureClock).toISOString();
  const path = join(stashDir, `${stashedAt.replaceAll(":", "-")}-${id}.json`);
  const entry = { id, text, inputMode: "normal", stashedAt, origin: { sessionId }, attachments: [], locked: false, preserved: false };
  writeFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return path;
}

function stashEntries(): StoredEntry[] {
  return readdirSync(stashDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(stashDir, name), "utf8")));
}

// Mirrors OMP's setEditorComponent: the factory's editor becomes the focused composer and
// receives only the previous composer's text.
function host(sessionId: string, options: { custom?: unknown } = {}) {
  const state = { composer: new Editor(EDITOR_THEME) };
  const tui = { getFocused: () => state.composer, requestRender() {} };
  const ctx = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => "Editor flow tests",
      getHeader: () => ({ type: "session", id: sessionId, timestamp: "2026-10-07T12:00:00.000Z", cwd: agentDir }),
    },
    ui: {
      setEditorComponent(factory: Function) {
        const next = factory(tui, EDITOR_THEME, {});
        next.setText(state.composer.getText());
        state.composer = next;
      },
      getEditorText: () => state.composer.getText(),
      setEditorText: (text: string) => state.composer.setText(text),
      notify() {},
      custom: options.custom,
    },
  } as unknown as ExtensionContext;
  return { ctx, state };
}

// Each browser opening presses the next key list; later openings close with Escape.
function browserKeys(...openings: string[][]) {
  let opening = 0;
  return (factory: Function) => {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    const tui = { terminal: { rows: 40, write() {} }, requestRender() {}, stop() {}, start() {} };
    const component = factory(tui, BROWSER_THEME, undefined, resolve);
    for (const key of openings[opening++] ?? ["\u001b"]) component.handleInput(key);
    return promise;
  };
}

beforeAll(async () => {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // getPluginSettings also merges <config root>/plugins/omp-plugins.lock.json, and the config root is
  // os.homedir() joined with PI_CONFIG_DIR. Bun reads HOME only at startup, so point PI_CONFIG_DIR here.
  process.env.PI_CONFIG_DIR = relative(homedir(), agentDir);
  // Test files share one module registry, so re-read the agent dir another file may have frozen.
  refreshDirsFromEnv();
  // Not static imports: SDK modules cache agent-dir paths as they load, so they must load after
  // the override above or the tests could touch the user's real stash.
  ({ CustomEditor: Editor } = await import("@oh-my-pi/pi-coding-agent/modes/components"));
  ({ getKeybindings } = await import("@oh-my-pi/pi-tui"));
  ({ ExtensionUiController: UiController } = await import(
    "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller"
  ));
  ({ OVERLAY_OPTIONS, selectOption } = await import("../extensions/ui"));
  const { default: promptStash } = await import("../extensions/prompt-stash.ts");
  await promptStash({
    on(event: string, handler: typeof sessionStart) {
      if (event === "session_start") sessionStart = handler;
    },
    registerShortcut(_key: string, shortcut: { handler: Handler }) {
      shortcuts.push(shortcut.handler);
    },
    registerCommand(name: string, command: { handler: typeof stashCommand }) {
      if (name === "stash") stashCommand = command.handler;
    },
  } as unknown as ExtensionAPI);
});

beforeEach(async () => {
  rmSync(stashDir, { recursive: true, force: true });
  mkdirSync(stashDir, { mode: 0o700 });
  writeSettings({});
  // Plugin config is module state shared with other test files.
  await sessionStart({}, { cwd: agentDir } as ExtensionContext);
});

afterAll(() => {
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  if (previousConfigDir === undefined) {
    delete process.env.PI_CONFIG_DIR;
  } else {
    process.env.PI_CONFIG_DIR = previousConfigDir;
  }
  refreshDirsFromEnv();
  rmSync(agentDir, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")("a no-op external edit keeps the stash's trailing newline", async () => {
  const sessionId = randomUUID();
  const path = writeStash(sessionId, "keep my trailing newline\n");
  // `true` exits without touching the file, like quitting an editor unchanged.
  writeSettings({ "Editor command": "true" });
  await sessionStart({}, { cwd: agentDir } as ExtensionContext);
  const { ctx } = host(sessionId, { custom: browserKeys(["e"]) });

  await stashCommand("", ctx);

  expect(stashEntries()).toHaveLength(1);
  expect(JSON.parse(readFileSync(path, "utf8")).text).toBe("keep my trailing newline\n");
});

test.skipIf(process.platform === "win32")("an editor that adds a final newline on save leaves the stash unchanged", async () => {
  const sessionId = randomUUID();
  const path = writeStash(sessionId, "no trailing newline");
  const ran = join(agentDir, "editor-ran");
  // Saves the file unchanged except for a final newline, as vim, nano, and helix do.
  writeSettings({ "Editor command": `touch '${ran}' && printf '\\n' >>` });
  await sessionStart({}, { cwd: agentDir } as ExtensionContext);
  const { ctx } = host(sessionId, { custom: browserKeys(["e"]) });

  await stashCommand("", ctx);

  expect(existsSync(ran)).toBeTrue();
  expect(stashEntries()).toHaveLength(1);
  expect(JSON.parse(readFileSync(path, "utf8")).text).toBe("no trailing newline");
});

test("installing the bridge keeps pasted payloads typed before session start", async () => {
  const { ctx, state } = host(randomUUID());
  const startup = state.composer;
  const pasted = image("pasted before session start");
  startup.setDraft("early draft [Image #1]", [pasted]);
  startup.insertPaste("pasted line\n".repeat(20));
  const draft = startup.getExpandedText();

  await sessionStart({}, ctx);

  expect(state.composer).toBe(startup);
  expect(state.composer.getExpandedText()).toBe(draft);
  expect(state.composer.pendingImages).toEqual([pasted]);
});

test("a deleted image chip leaves the composer empty for restore", async () => {
  const sessionId = randomUUID();
  writeStash(sessionId, "restore me");
  const { ctx, state } = host(sessionId);
  await sessionStart({}, ctx);
  const deleteChip = () => {
    state.composer.setDraft("[Image #1]", [image("discarded")]);
    // Backspace removes the whole chip; OMP keeps the image record so numbers are not reused.
    state.composer.handleInput("\x7f");
    expect(state.composer.getText()).toBe("");
    expect(state.composer.pendingImages).toHaveLength(1);
  };

  deleteChip();
  await stashCommand("restore", ctx);
  expect(state.composer.getText()).toBe("restore me");

  deleteChip();
  await shortcuts[0]!(ctx);
  expect(state.composer.getText()).toBe("restore me");
  expect(state.composer.pendingImages).toEqual([]);
  expect(stashEntries()).toHaveLength(1);
});

test("stashing drops images whose chips were deleted and renumbers the rest", async () => {
  const { ctx, state } = host(randomUUID());
  await sessionStart({}, ctx);
  const kept = image("kept");
  // Chip #1 was deleted: its image stays in pendingImages but the text no longer references it.
  state.composer.setDraft("keep [Image #2]", [image("deleted"), kept]);

  await shortcuts[0]!(ctx);
  const [entry] = stashEntries();
  expect(entry?.attachments).toHaveLength(1);
  expect(entry?.text).toBe("keep [Image #1]");

  await shortcuts[0]!(ctx);
  expect(state.composer.getExpandedText()).toBe("keep [Image #1]");
  expect(state.composer.pendingImages.map((restored) => restored.data)).toEqual([kept.data]);
});

test("stashed images keep the display extensions OMP derives from their MIME types", async () => {
  // OhMyStash carries its own copy of this pi-tui helper; compiled OMP does not serve prompt/*.
  const mimeTypes = [
    "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/svg+xml",
    "image/PNG", "image/avif", "image/x-icon; charset=binary", "image/vnd.example+xml", "image/.heic",
    "image/bad name", `image/${"a".repeat(33)}`, "image/",
  ];
  const { ctx, state } = host(randomUUID());
  await sessionStart({}, ctx);
  const images = mimeTypes.map((mimeType) => ({ ...image(mimeType), mimeType }));
  state.composer.setDraft(images.map((_, index) => `[Image #${index + 1}]`).join(" "), images);

  await shortcuts[0]!(ctx);

  expect(stashEntries()[0]?.attachments).toHaveLength(mimeTypes.length);
  const names = readdirSync(join(stashDir, "attachments"));
  for (const mimeType of mimeTypes) {
    const hash = new Bun.SHA256().update(mimeType).digest("hex");
    const extension = blobExtensionForImageMimeType(mimeType);
    expect(names.filter((name) => name.startsWith(hash)).sort()).toEqual(
      extension ? [hash, `${hash}.${extension}`] : [hash],
    );
  }
});

test("submitting a queued stash does not depend on the Enter keybinding", async () => {
  const sessionId = randomUUID();
  writeStash(sessionId, "queued work");
  const { ctx, state } = host(sessionId, { custom: browserKeys(["Q"]) });
  await sessionStart({}, ctx);
  const submissions: string[] = [];
  state.composer.onSubmit = (text) => {
    submissions.push(text);
  };
  const keybindings = getKeybindings();
  const saved = keybindings.getUserBindings();
  keybindings.setUserBindings({ ...saved, "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" });
  try {
    await stashCommand("", ctx);
  } finally {
    keybindings.setUserBindings(saved);
  }

  expect(submissions).toEqual(["/queue queued work"]);
});

test("a second browser press in the same input batch is ignored", async () => {
  const sessionId = randomUUID();
  writeStash(sessionId, "browse me");
  const closers: Array<(action: null) => void> = [];
  const { ctx } = host(sessionId, {
    custom: () => {
      const { promise, resolve } = Promise.withResolvers<null>();
      closers.push(resolve);
      return promise;
    },
  });
  const browserShortcut = shortcuts[1]!;

  const first = browserShortcut(ctx);
  const second = browserShortcut(ctx);
  expect(closers).toHaveLength(1);
  closers[0]!(null);
  await Promise.all([first, second]);

  // A later press opens a new browser, even if another dialog displaced the first one.
  const later = browserShortcut(ctx);
  expect(closers).toHaveLength(2);
  closers[1]!(null);
  await later;
});

test("a composer replaced by another extension is never driven through the stale editor", async () => {
  const sessionId = randomUUID();
  writeStash(sessionId, "restore target");
  const { ctx, state } = host(sessionId);
  await sessionStart({}, ctx);
  const stale = state.composer;
  stale.setDraft("stale draft [Image #1]", [image("stale")]);
  // Another extension swaps the composer; OMP hands the new one only the text.
  const replacement = new Editor(EDITOR_THEME);
  replacement.setText(stale.getText());
  state.composer = replacement;

  await shortcuts[0]!(ctx);
  expect(stashEntries()).toHaveLength(1);
  expect(stale.getExpandedText()).toBe("stale draft [Image #1]");
  expect(stale.pendingImages).toHaveLength(1);
  expect(replacement.getText()).toBe(stale.getText());

  replacement.setText("");
  await shortcuts[0]!(ctx);
  expect(replacement.getText()).toBe("restore target");
  expect(stale.getExpandedText()).toBe("stale draft [Image #1]");
});

test("closing a picker or the browser keeps the composer's text, caret, and undo history", async () => {
  const sessionId = randomUUID();
  writeStash(sessionId, "browse me");
  const mounts: unknown[] = [];
  const overlays: unknown[] = [];
  // OMP's own controller backs ctx.ui.custom. Like pi-tui, the TUI focuses whatever it mounts, and
  // the user then cancels it with Escape.
  const tui = {
    terminal: { rows: 40, columns: 100 },
    showOverlay(component: Tui.Component, options: unknown) {
      overlays.push(options);
      this.setFocus(component);
      return { hide() {}, setHidden() {}, isHidden: () => false };
    },
    setFocus(component: Tui.Component) {
      if (component !== state.composer) queueMicrotask(() => component.handleInput?.("\u001b"));
    },
    requestRender() {},
  };
  const custom: ExtensionContext["ui"]["custom"] = (factory, options) => {
    mounts.push(options);
    return controller.showHookCustom(factory, options);
  };
  const { ctx, state } = host(sessionId, { custom });
  const controller = new UiController({
    get editor() {
      return state.composer;
    },
    editorContainer: { clear() {}, addChild() {} },
    ui: tui,
  } as unknown as ConstructorParameters<typeof UiController>[0]);
  await sessionStart({}, ctx);
  state.composer.setText("draft");
  state.composer.handleInput("s");
  state.composer.handleInput("\u001b[D");
  const caret = state.composer.getCursor();

  expect(await selectOption(ctx, "Pick one", ["Alpha", "Beta"])).toBeUndefined();
  await stashCommand("", ctx);

  expect(mounts).toHaveLength(2);
  for (const options of mounts) expect(options).toBe(OVERLAY_OPTIONS);
  // Switch Model's placement: bottom-anchored, full width, up to every terminal row.
  const switchModel = { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0 };
  expect(overlays).toEqual([switchModel, switchModel]);
  expect(state.composer.getText()).toBe("drafts");
  expect(state.composer.getCursor()).toEqual(caret);
  // Ctrl+_ is OMP's default undo key.
  state.composer.handleInput("\u001f");
  expect(state.composer.getText()).toBe("draft");
});
