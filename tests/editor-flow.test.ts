import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components";
import type { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import type * as Tui from "@oh-my-pi/pi-tui";
import { blobExtensionForImageMimeType } from "@oh-my-pi/pi-tui/prompt/image-format";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import type * as PopupUi from "../extensions/ui";
import { SEND_TARGETS_CHANNEL, type SendTarget, type SendTargetsRequest, type SentPrompt } from "../extensions/send-targets";

type Handler = (ctx: ExtensionContext) => Promise<void> | void;
type StoredEntry = { text: string; attachments: unknown[]; usedAt?: string };

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
// The plugin's factory; OMP calls it again for every subagent.
let loadPlugin: (pi: ExtensionAPI) => Promise<void>;
let sessionStart: (event: unknown, ctx: ExtensionContext) => Promise<void>;
let stashCommand: (args: string, ctx: ExtensionContext) => Promise<void> | void;
// Registration order: the stash shortcut, then the browser shortcut.
const shortcuts: Handler[] = [];
// Fixtures predate anything the tests stash, so "restore latest" picks fresh stashes first.
let fixtureClock = Date.now() - 3_600_000;
// The pi.events bus. Each test registers its own listeners; beforeEach clears them.
const busListeners = new Map<string, Array<(data: unknown) => void>>();
const bus = {
  emit(channel: string, data: unknown) {
    for (const listener of busListeners.get(channel) ?? []) listener(data);
  },
};

function offerTargets(...targets: SendTarget[]): void {
  busListeners.set(SEND_TARGETS_CHANNEL, [(data) => {
    for (const target of targets) (data as SendTargetsRequest).add(target);
  }]);
}

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
function host(sessionId: string, options: { custom?: unknown; notices?: string[] } = {}) {
  const state = { composer: new Editor(EDITOR_THEME) };
  const tui = { getFocused: () => state.composer, requestRender() {} };
  const ctx = {
    cwd: agentDir,
    mode: "tui",
    agent: { kind: "main" },
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
      notify(message: string) {
        options.notices?.push(message);
      },
      confirm: async () => true,
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
  ({ default: loadPlugin } = await import("../extensions/prompt-stash.ts"));
  await loadPlugin({
    events: bus,
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

// session_start reloads the settings only for the main TUI session.
const CONFIG_CONTEXT = {
  cwd: agentDir, mode: "tui", agent: { kind: "main" }, ui: { setEditorComponent() {} },
} as unknown as ExtensionContext;

beforeEach(async () => {
  rmSync(stashDir, { recursive: true, force: true });
  busListeners.clear();
  mkdirSync(stashDir, { mode: 0o700 });
  writeSettings({});
  // Plugin config is module state shared with other test files.
  await sessionStart({}, CONFIG_CONTEXT);
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
  await sessionStart({}, CONFIG_CONTEXT);
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
  await sessionStart({}, CONFIG_CONTEXT);
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

test("s sends the selected stash to another plugin's target and keeps the stash and the draft", async () => {
  const sessionId = randomUUID();
  writeStash(sessionId, "loop this");
  const sent: SentPrompt[] = [];
  offerTargets({ label: "Elsewhere", send: (prompt) => void sent.push(prompt) });
  const { ctx, state } = host(sessionId, { custom: browserKeys(["s"]) });
  await sessionStart({}, ctx);
  state.composer.setText("keep my draft");

  await stashCommand("", ctx);

  expect(sent).toEqual([{ text: "loop this", images: 0 }]);
  expect(state.composer.getText()).toBe("keep my draft");
  const [entry] = stashEntries();
  expect(entry?.text).toBe("loop this");
  expect(entry?.usedAt).toBeString();
});

test("with several targets, s asks which one gets the stash", async () => {
  const sessionId = randomUUID();
  writeStash(sessionId, "pick a place");
  const sent: string[] = [];
  offerTargets(
    { label: "First", send: () => void sent.push("First") },
    { label: "Second", send: () => void sent.push("Second") },
  );
  const { ctx } = host(sessionId, { custom: browserKeys(["s"], ["\u001b[B", "\r"]) });
  await sessionStart({}, ctx);

  await stashCommand("", ctx);

  expect(sent).toEqual(["Second"]);
});

test("s does nothing when no plugin offers a target", async () => {
  const sessionId = randomUUID();
  writeStash(sessionId, "stay here");
  const notices: string[] = [];
  const { ctx, state } = host(sessionId, { custom: browserKeys(["s", "\u001b"]), notices });
  await sessionStart({}, ctx);

  await stashCommand("", ctx);

  expect(state.composer.getText()).toBe("");
  expect(stashEntries()[0]?.usedAt).toBeUndefined();
  expect(notices).toEqual([]);
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

// A stash file written straight to disk, so a test can date it and set its fields.
function writeRawStash(sessionId: string, text: string, fields: Record<string, unknown> = {}): string {
  fixtureClock += 1;
  const id = randomUUID();
  const stashedAt = typeof fields.stashedAt === "string" ? fields.stashedAt : new Date(fixtureClock).toISOString();
  const path = join(stashDir, `${stashedAt.replaceAll(":", "-")}-${id}.json`);
  const entry = { id, text, inputMode: "normal", stashedAt, origin: { sessionId }, attachments: [], locked: false, preserved: false };
  writeFileSync(path, `${JSON.stringify({ ...entry, ...fields })}\n`, { mode: 0o600 });
  return path;
}

function backdate(path: string, ageMs: number): void {
  const then = new Date(Date.now() - ageMs);
  utimesSync(path, then, then);
}

test("stashing this chat's newest stash again keeps one stash, while other drafts still add one", async () => {
  const notices: string[] = [];
  const { ctx, state } = host(randomUUID(), { notices });
  await sessionStart({}, ctx);
  const picture = image("same picture");
  state.composer.setDraft("same draft [Image #1]", [picture]);
  await shortcuts[0]!(ctx);
  await shortcuts[0]!(ctx);
  expect(state.composer.pendingImages).toEqual([picture]);
  await shortcuts[0]!(ctx);

  expect(stashEntries()).toHaveLength(1);
  expect(stashEntries()[0]?.usedAt).toBeString();
  expect(notices.at(-1)).toBe("Prompt was already this chat's latest stash, so OMS kept that one");
  // Another mode, other text, or a stash that's no longer the newest each make a new one.
  state.composer.setDraft("/queue same draft [Image #1]", [picture]);
  await shortcuts[0]!(ctx);
  state.composer.setDraft("other draft", []);
  await shortcuts[0]!(ctx);
  state.composer.setDraft("same draft [Image #1]", [picture]);
  await shortcuts[0]!(ctx);
  expect(stashEntries()).toHaveLength(4);
});

test("p restores a stash and deletes it with the attachments nothing else uses, but keeps a locked one", async () => {
  const sessionId = randomUUID();
  const notices: string[] = [];
  const { ctx, state } = host(sessionId, { custom: browserKeys(["p"]), notices });
  await sessionStart({}, ctx);
  const picture = image("pop picture");
  state.composer.setDraft("pop me [Image #1]", [picture]);
  await shortcuts[0]!(ctx);
  const attachments = join(stashDir, "attachments");
  // Older than the window in which a save running elsewhere could be about to use it.
  for (const name of readdirSync(attachments)) backdate(join(attachments, name), 120_000);

  await stashCommand("", ctx);

  expect(state.composer.getExpandedText()).toBe("pop me [Image #1]");
  expect(state.composer.pendingImages).toEqual([picture]);
  expect(stashEntries()).toEqual([]);
  expect(readdirSync(attachments)).toEqual([]);
  expect(notices.at(-1)).toContain("Popped prompt");

  const locked = writeRawStash(sessionId, "locked pop", { locked: true });
  const second = host(sessionId, { custom: browserKeys(["p"]), notices });
  await sessionStart({}, second.ctx);
  await stashCommand("", second.ctx);
  expect(second.state.composer.getText()).toBe("locked pop");
  expect(existsSync(locked)).toBeTrue();
  expect(notices.at(-1)).toContain("locked stashes stay after a pop");
});

test("retention counts from a stash's last restore", async () => {
  const sessionId = randomUUID();
  const daysAgo = (days: number, offset: number) => new Date(Date.now() - days * 86_400_000 + offset).toISOString();
  const restoredLately = writeRawStash(randomUUID(), "restored an hour ago", {
    stashedAt: daysAgo(3, 0),
    usedAt: new Date(Date.now() - 3_600_000).toISOString(),
  });
  const neverRestored = writeRawStash(randomUUID(), "never restored", { stashedAt: daysAgo(3, 1) });
  const restoredNow = writeRawStash(sessionId, "restored now", { stashedAt: daysAgo(3, 2) });
  const { ctx, state } = host(sessionId);
  await sessionStart({}, ctx);
  await stashCommand("restore", ctx);
  expect(state.composer.getText()).toBe("restored now");

  writeSettings({ "Retention days": 2 });
  await sessionStart({}, CONFIG_CONTEXT);
  expect(existsSync(neverRestored)).toBeFalse();
  expect(existsSync(restoredLately)).toBeTrue();
  expect(existsSync(restoredNow)).toBeTrue();
});

test("deleting a stash deletes the attachments no other stash uses, and old leftovers", async () => {
  const { ctx, state } = host(randomUUID(), { custom: browserKeys(["d"]) });
  await sessionStart({}, ctx);
  state.composer.setDraft("[Image #1] kept", [image("shared picture")]);
  await shortcuts[0]!(ctx);
  state.composer.setDraft("[Image #1] [Image #2] deleted", [image("shared picture"), image("only picture")]);
  await shortcuts[0]!(ctx);
  const attachments = join(stashDir, "attachments");
  for (const name of readdirSync(attachments)) backdate(join(attachments, name), 120_000);
  const leftover = (dir: string, name: string, ageMs: number) => {
    const path = join(dir, name);
    writeFileSync(path, "leftover", { mode: 0o600 });
    backdate(path, ageMs);
    return path;
  };
  leftover(attachments, `.${randomUUID()}.asset.tmp`, 2 * 86_400_000);
  leftover(attachments, "a".repeat(64), 120_000);
  // A save running elsewhere may be about to use an asset this new.
  leftover(attachments, "b".repeat(64), 0);
  const oldOrphan = leftover(stashDir, `.${randomUUID()}.tmp.orphan`, 8 * 86_400_000);
  const recentOrphan = leftover(stashDir, `.${randomUUID()}.tmp.orphan`, 86_400_000);

  // The browser lists the newest stash first, so d deletes the two-image one.
  await stashCommand("", ctx);

  const shared = new Bun.SHA256().update("shared picture").digest("hex");
  expect(stashEntries().map((entry) => entry.text)).toEqual(["[Image #1] kept"]);
  expect(readdirSync(attachments).sort()).toEqual([shared, `${shared}.png`, "b".repeat(64)].sort());
  expect(existsSync(oldOrphan)).toBeFalse();
  expect(existsSync(recentOrphan)).toBeTrue();
});

test("new attachments stop at the 1 GiB attachment quota, while text stashes still save", async () => {
  const notices: string[] = [];
  const { ctx, state } = host(randomUUID(), { notices });
  await sessionStart({}, ctx);
  const attachments = join(stashDir, "attachments");
  mkdirSync(attachments, { mode: 0o700 });
  // A new asset that fills the quota by itself. It's sparse, so it takes no disk space.
  const fd = openSync(join(attachments, "c".repeat(64)), "w", 0o600);
  ftruncateSync(fd, 1024 * 1024 * 1024);
  closeSync(fd);

  state.composer.setDraft("[Image #1] one too many", [image("one more picture")]);
  await shortcuts[0]!(ctx);
  expect(notices.at(-1)).toContain("OMS attachment storage is full (1 GiB across all chats)");
  expect(state.composer.getExpandedText()).toBe("[Image #1] one too many");
  expect(stashEntries()).toEqual([]);

  state.composer.setDraft("text still fits", []);
  await shortcuts[0]!(ctx);
  expect(stashEntries().map((entry) => entry.text)).toEqual(["text still fits"]);
});

test("a subagent's plugin load and session start leave the main session's settings and stashes alone", async () => {
  const expired = writeRawStash(randomUUID(), "expired", { stashedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
  writeSettings({ "Retention days": 1, "Browser layout": "Compact" });
  // Subagents load every plugin again in the same process, then start a print-mode session.
  await loadPlugin({ on() {}, registerShortcut() {}, registerCommand() {} } as unknown as ExtensionAPI);
  await sessionStart({}, {
    cwd: agentDir, mode: "print", agent: { kind: "sub" }, ui: { setEditorComponent() {} },
  } as unknown as ExtensionContext);
  expect(existsSync(expired)).toBeTrue();

  // The main session's browser keeps its framed layout instead of the compact one the subagent read.
  const titles: string[] = [];
  const { ctx } = host(randomUUID(), {
    custom(factory: Function) {
      const component = factory({ terminal: { rows: 40 }, requestRender() {} }, BROWSER_THEME, undefined, () => {});
      titles.push(component.render(120)[0] ?? "");
      return Promise.resolve(null);
    },
  });
  await stashCommand("", ctx);
  expect(titles[0]).toStartWith("┌");
});

test.skipIf(process.platform === "win32")("names shared storage with its chmod fix, and sets damaged stash files aside once", async () => {
  const sessionId = randomUUID();
  const notices: string[] = [];
  const { ctx, state } = host(sessionId, { custom: browserKeys(), notices });
  await sessionStart({}, ctx);
  writeStash(sessionId, "visible stash");
  // Copied with shared permissions, as cp -r or a sync tool can do.
  chmodSync(writeStash(sessionId, "shared stash"), 0o644);
  writeFileSync(join(stashDir, `2026-01-01T00-00-00.000Z-${randomUUID()}.json`), "{ torn", { mode: 0o600 });
  const hidden = `1 OMS stash is hidden because its file is shared with other accounts. Run: chmod 600 '${stashDir}'/*.json`;

  await stashCommand("", ctx);
  expect(notices).toEqual([hidden, `1 damaged OMS stash file was set aside in ${stashDir} with an .invalid or .orphan suffix`]);
  expect(readdirSync(stashDir).filter((name) => name.endsWith(".invalid"))).toHaveLength(1);
  // The damaged file is reported once, and the shared one until it's fixed.
  notices.length = 0;
  await stashCommand("", ctx);
  expect(notices).toEqual([hidden]);

  chmodSync(stashDir, 0o755);
  try {
    state.composer.setText("stash me");
    await shortcuts[0]!(ctx);
    expect(notices.at(-1)).toBe(`OMS failed: OMS storage directory is shared with other accounts. Run: chmod 700 '${stashDir}'`);
    expect(state.composer.getText()).toBe("stash me");
  } finally {
    chmodSync(stashDir, 0o700);
  }
});
