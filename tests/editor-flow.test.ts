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
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import type * as PopupUi from "../extensions/ui";
import { bodyAttachment, imageAttachment } from "./fixtures/stash-assets";
import { SEND_TARGETS_CHANNEL, type SendTarget, type SendTargetsRequest, type SentPrompt } from "../extensions/send-targets";

type Handler = (ctx: ExtensionContext) => Promise<void> | void;
type StoredEntry = { text: string; attachments: unknown[]; usedAt?: string };

const agentDir = mkdtempSync(join(tmpdir(), "oms-editor-flow-"));
const stashDir = join(agentDir, "prompt-stash");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousConfigDir = process.env.PI_CONFIG_DIR;
// What pi.sendUserMessage was asked to send.
const userMessages: Array<{ content: unknown; options: unknown }> = [];
const BROWSER_THEME = {
  isLight: false,
  getFgAnsi: () => "\u001b[39m",
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  symbol: (name: string) => name,
};

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

// A stand-in composer: OMP 19.2 lets a plugin read and set the draft's text only, through
// getEditorText and setEditorText. `writes` counts the plugin's own changes to it.
function host(sessionId: string, options: { custom?: unknown; notices?: string[]; idle?: boolean } = {}) {
  const state = { text: "", writes: 0 };
  const ctx = {
    cwd: agentDir,
    mode: "tui",
    agent: { kind: "main" },
    isIdle: () => options.idle ?? true,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => "Editor flow tests",
      getHeader: () => ({ type: "session", id: sessionId, timestamp: "2026-10-07T12:00:00.000Z", cwd: agentDir }),
    },
    ui: {
      getEditorText: () => state.text,
      setEditorText: (text: string) => {
        state.writes += 1;
        state.text = text;
      },
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
    const ui = { size: () => ({ columns: 120, rows: 40 }), requestRender() {}, suspend: <R>(run: () => Promise<R>) => run() };
    const component = factory(ui, BROWSER_THEME, undefined, resolve);
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
  ({ OVERLAY_OPTIONS, selectOption } = await import("../extensions/ui"));
  let startupScanSettled: () => Promise<void>;
  ({ default: loadPlugin, startupScanSettled } = await import("../extensions/prompt-stash.ts"));
  await loadPlugin({
    events: bus,
    on(event: string, handler: typeof sessionStart) {
      // OMP does not wait for the deferred retention scan, so tests wait for it here.
      if (event === "session_start") {
        sessionStart = async (...args) => {
          await handler(...args);
          await startupScanSettled();
        };
      }
    },
    sendUserMessage(content: unknown, options: unknown) {
      userMessages.push({ content, options });
      return Promise.resolve();
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
  cwd: agentDir, mode: "tui", agent: { kind: "main" }, ui: {},
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

test("stashing refuses a draft that holds a pasted block or attachment chip, and leaves the draft", async () => {
  const notices: string[] = [];
  const { ctx, state } = host(randomUUID(), { notices });
  await sessionStart({}, ctx);
  // OMP lets a plugin read only the chip's label, not the image or text it stands for.
  for (const draft of ["look [Image #1]", "see 📄 #1 and more", "[Paste #2, +20 lines]"]) {
    notices.length = 0;
    state.text = draft;
    await shortcuts[0]!(ctx);
    expect(notices.at(-1)).toContain("pasted block or attachment");
    expect(state.text).toBe(draft);
  }
  expect(stashEntries()).toEqual([]);
  expect(state.writes).toBe(0);
});

test("restoring a stash with images puts its text back and names the images OMP can't attach", async () => {
  const sessionId = randomUUID();
  writeRawStash(sessionId, "look [Image #1] closely", { attachments: [imageAttachment(stashDir, "restored picture")] });
  const notices: string[] = [];
  const { ctx, state } = host(sessionId, { notices });
  await sessionStart({}, ctx);

  await stashCommand("restore", ctx);

  expect(state.text).toBe("look [Image #1 unavailable] closely");
  expect(notices.at(-1)).toContain(
    "couldn't restore Image #1 (OMP doesn't let plugins attach images to the composer)",
  );
  expect(stashEntries()).toHaveLength(1);
});

test("restoring a large pasted body puts the whole text back in the draft", async () => {
  const sessionId = randomUUID();
  const body = "large paste line\n".repeat(70_000);
  writeRawStash(sessionId, "[Large pasted prompt · 70001 lines]", { attachments: [bodyAttachment(stashDir, body)] });
  const notices: string[] = [];
  const { ctx, state } = host(sessionId, { notices });
  await sessionStart({}, ctx);

  await stashCommand("restore", ctx);

  expect(state.text).toBe(body);
  expect(notices.at(-1)).toContain("restore never deletes stash files");
});

test("Q sends a queued stash as a user message and leaves the composer alone", async () => {
  const sessionId = randomUUID();
  writeStash(sessionId, "queued work");
  const { ctx, state } = host(sessionId, { custom: browserKeys(["Q"]) });
  await sessionStart({}, ctx);
  userMessages.length = 0;

  await stashCommand("", ctx);

  // An idle session starts a turn with it.
  expect(userMessages).toEqual([{ content: "queued work", options: undefined }]);
  expect(state.writes).toBe(0);
  expect(stashEntries()[0]?.usedAt).toBeString();

  // A busy one queues it behind the current turn, like /queue.
  const busy = host(sessionId, { custom: browserKeys(["Q"]), idle: false });
  userMessages.length = 0;
  await stashCommand("", busy.ctx);
  expect(userMessages).toEqual([{ content: "queued work", options: { deliverAs: "followUp" } }]);
});

test("Q sends a queued stash's images with its text", async () => {
  const sessionId = randomUUID();
  writeRawStash(sessionId, "compare [Image #1]", { attachments: [imageAttachment(stashDir, "queued picture")] });
  const { ctx } = host(sessionId, { custom: browserKeys(["Q"]) });
  await sessionStart({}, ctx);
  userMessages.length = 0;

  await stashCommand("", ctx);

  expect(userMessages).toEqual([{
    content: [
      { type: "text", text: "compare [Image #1]" },
      { type: "image", data: Buffer.from("queued picture").toString("base64"), mimeType: "image/png" },
    ],
    options: undefined,
  }]);
});

test("Q stops at a draft when an image can't be read, and sends nothing", async () => {
  const sessionId = randomUUID();
  const picture = imageAttachment(stashDir, "damaged picture");
  writeRawStash(sessionId, "compare [Image #1]", { attachments: [picture] });
  // Same-size garbage fails the content hash check.
  writeFileSync(join(stashDir, "attachments", picture.ref.slice("sha256:".length)), Buffer.alloc(picture.byteLength, 0x21), {
    mode: 0o600,
  });
  const notices: string[] = [];
  const { ctx, state } = host(sessionId, { custom: browserKeys(["Q"]), notices });
  await sessionStart({}, ctx);
  userMessages.length = 0;

  await stashCommand("", ctx);

  expect(userMessages).toEqual([]);
  expect(state.text).toBe("/queue compare [Image #1 unavailable]");
  expect(notices.at(-1)).toContain("Inserted the queued draft without submitting it, because Image #1 (damaged)");
});

test("s sends the selected stash to another plugin's target and keeps the stash and the draft", async () => {
  const sessionId = randomUUID();
  writeStash(sessionId, "loop this");
  const sent: SentPrompt[] = [];
  offerTargets({ label: "Elsewhere", send: (prompt) => void sent.push(prompt) });
  const { ctx, state } = host(sessionId, { custom: browserKeys(["s"]) });
  await sessionStart({}, ctx);
  state.text = "keep my draft";

  await stashCommand("", ctx);

  expect(sent).toEqual([{ text: "loop this", images: 0 }]);
  expect(state.text).toBe("keep my draft");
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

  expect(state.text).toBe("");
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

test("closing a picker or the browser leaves the composer alone", async () => {
  const sessionId = randomUUID();
  writeStash(sessionId, "browse me");
  const mounts: unknown[] = [];
  // The user cancels each view with Escape as soon as it mounts.
  const cancel = browserKeys();
  const custom = (factory: Function, options: unknown) => {
    mounts.push(options);
    return cancel(factory);
  };
  const { ctx, state } = host(sessionId, { custom });
  await sessionStart({}, ctx);
  state.text = "draft";

  expect(await selectOption(ctx, "Pick one", ["Alpha", "Beta"])).toBeUndefined();
  await stashCommand("", ctx);

  // Stock bottom overlay, and neither view reads or sets the draft: OMP refocuses the composer on close, so
  // its text, caret, and undo history stay as they were.
  expect(mounts).toHaveLength(2);
  for (const options of mounts) expect(options).toBe(OVERLAY_OPTIONS);
  expect(state.text).toBe("draft");
  expect(state.writes).toBe(0);
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
  state.text = "same draft";
  await shortcuts[0]!(ctx);
  expect(state.text).toBe("");
  await shortcuts[0]!(ctx);
  expect(state.text).toBe("same draft");
  await shortcuts[0]!(ctx);

  expect(stashEntries()).toHaveLength(1);
  expect(stashEntries()[0]?.usedAt).toBeString();
  expect(notices.at(-1)).toBe("Prompt was already this chat's latest stash, so OMS kept that one");
  // Another mode, other text, or a stash that's no longer the newest each make a new one.
  state.text = "/queue same draft";
  await shortcuts[0]!(ctx);
  state.text = "other draft";
  await shortcuts[0]!(ctx);
  state.text = "same draft";
  await shortcuts[0]!(ctx);
  expect(stashEntries()).toHaveLength(4);
});

test("p restores a stash and deletes it with the attachments nothing else uses, but keeps a locked one", async () => {
  const sessionId = randomUUID();
  const notices: string[] = [];
  const body = "pop line\n".repeat(10);
  writeRawStash(sessionId, "[Large pasted prompt · 11 lines]", { attachments: [bodyAttachment(stashDir, body)] });
  const attachments = join(stashDir, "attachments");
  // Older than the window in which a save running elsewhere could be about to use it.
  for (const name of readdirSync(attachments)) backdate(join(attachments, name), 120_000);
  const { ctx, state } = host(sessionId, { custom: browserKeys(["p"]), notices });
  await sessionStart({}, ctx);

  await stashCommand("", ctx);

  expect(state.text).toBe(body);
  expect(stashEntries()).toEqual([]);
  expect(readdirSync(attachments)).toEqual([]);
  expect(notices.at(-1)).toContain("Popped prompt");

  const locked = writeRawStash(sessionId, "locked pop", { locked: true });
  const second = host(sessionId, { custom: browserKeys(["p"]), notices });
  await sessionStart({}, second.ctx);
  await stashCommand("", second.ctx);
  expect(second.state.text).toBe("locked pop");
  expect(existsSync(locked)).toBeTrue();
  expect(notices.at(-1)).toContain("locked stashes stay after a pop");
});

test("p keeps a stash whose images couldn't be attached", async () => {
  const sessionId = randomUUID();
  const notices: string[] = [];
  writeRawStash(sessionId, "pop [Image #1]", { attachments: [imageAttachment(stashDir, "kept picture")] });
  const { ctx, state } = host(sessionId, { custom: browserKeys(["p"]), notices });
  await sessionStart({}, ctx);

  await stashCommand("", ctx);

  expect(state.text).toBe("pop [Image #1 unavailable]");
  expect(stashEntries()).toHaveLength(1);
  expect(notices.at(-1)).toContain("couldn't restore Image #1");
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
  expect(state.text).toBe("restored now");

  writeSettings({ "Retention days": 2 });
  await sessionStart({}, CONFIG_CONTEXT);
  expect(existsSync(neverRestored)).toBeFalse();
  expect(existsSync(restoredLately)).toBeTrue();
  expect(existsSync(restoredNow)).toBeTrue();
});

test("deleting a stash deletes the attachments no other stash uses, and old leftovers", async () => {
  const sessionId = randomUUID();
  const { ctx } = host(sessionId, { custom: browserKeys(["d"]) });
  await sessionStart({}, ctx);
  const shared = imageAttachment(stashDir, "shared picture");
  writeRawStash(sessionId, "[Image #1] kept", { attachments: [shared] });
  writeRawStash(sessionId, "[Image #1] [Image #2] deleted", {
    attachments: [shared, imageAttachment(stashDir, "only picture")],
  });
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

  const hash = shared.ref.slice("sha256:".length);
  expect(stashEntries().map((entry) => entry.text)).toEqual(["[Image #1] kept"]);
  expect(readdirSync(attachments).sort()).toEqual([hash, `${hash}.png`, "b".repeat(64)].sort());
  expect(existsSync(oldOrphan)).toBeFalse();
  expect(existsSync(recentOrphan)).toBeTrue();
});

test("a large pasted body stops at the 1 GiB attachment quota, while smaller stashes still save", async () => {
  const notices: string[] = [];
  const { ctx, state } = host(randomUUID(), { notices });
  await sessionStart({}, ctx);
  const attachments = join(stashDir, "attachments");
  mkdirSync(attachments, { mode: 0o700 });
  // A new asset that fills the quota by itself. It's sparse, so it takes no disk space.
  const fd = openSync(join(attachments, "c".repeat(64)), "w", 0o600);
  ftruncateSync(fd, 1024 * 1024 * 1024);
  closeSync(fd);

  const tooBig = "x".repeat(1024 * 1024 + 1);
  state.text = tooBig;
  await shortcuts[0]!(ctx);
  expect(notices.at(-1)).toContain("OMS attachment storage is full (1 GiB across all chats)");
  expect(state.text).toBe(tooBig);
  expect(stashEntries()).toEqual([]);

  state.text = "text still fits";
  await shortcuts[0]!(ctx);
  expect(stashEntries().map((entry) => entry.text)).toEqual(["text still fits"]);
});

test("a subagent's plugin load and session start leave the main session's settings and stashes alone", async () => {
  const expired = writeRawStash(randomUUID(), "expired", { stashedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
  writeSettings({ "Retention days": 1, "Browser layout": "Compact" });
  // Subagents load every plugin again in the same process, then start a print-mode session.
  await loadPlugin({ on() {}, registerShortcut() {}, registerCommand() {} } as unknown as ExtensionAPI);
  await sessionStart({}, {
    cwd: agentDir, mode: "print", agent: { kind: "sub" }, ui: {},
  } as unknown as ExtensionContext);
  expect(existsSync(expired)).toBeTrue();

  // The main session's browser keeps its framed layout instead of the compact one the subagent read.
  const titles: string[] = [];
  const { ctx } = host(randomUUID(), {
    custom(factory: Function) {
      const ui = { size: () => ({ columns: 120, rows: 40 }), requestRender() {}, suspend: <R>(run: () => Promise<R>) => run() };
      const component = factory(ui, BROWSER_THEME, undefined, () => {});
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
    state.text = "stash me";
    await shortcuts[0]!(ctx);
    expect(notices.at(-1)).toBe(`OMS failed: OMS storage directory is shared with other accounts. Run: chmod 700 '${stashDir}'`);
    expect(state.text).toBe("stash me");
  } finally {
    chmodSync(stashDir, 0o700);
  }
});
