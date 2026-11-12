import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  collectNativeHost,
  NATIVE_UI_CHANNEL,
  type NativeListEvent,
  type NativeListSpec,
  type NativeUiHost,
  type NativeUiRequest,
} from "../extensions/native-ui";
import { selectOption } from "../extensions/ui";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousConfigDir = process.env.PI_CONFIG_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "oms-native-ui-test-"));
const stashDir = join(agentDir, "prompt-stash");
const SESSION_ID = randomUUID();
let refreshDirsFromEnv: () => void;
let stashCommand: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void };
let sessionStart: (event: unknown, ctx: ExtensionContext) => Promise<void>;
let fixtureCount = 0;

// A pi.events stand-in: emit calls every listener on the channel.
const listeners = new Map<string, Set<(data: unknown) => void>>();
const events = {
  on(channel: string, listener: (data: unknown) => void) {
    const set = listeners.get(channel) ?? new Set();
    set.add(listener);
    listeners.set(channel, set);
    return () => set.delete(listener);
  },
  emit(channel: string, data: unknown) {
    for (const listener of listeners.get(channel) ?? []) listener(data);
  },
};

type FakeHost = NativeUiHost & { specs: NativeListSpec[]; closed: string[] };

// A host that answers each list call with the next scripted reply.
function fakeHost(replies: Array<(spec: NativeListSpec) => NativeListEvent | Promise<NativeListEvent>>): FakeHost {
  const host: FakeHost = {
    name: "Test host",
    specs: [],
    closed: [],
    async list(spec) {
      host.specs.push(spec);
      const reply = replies.shift();
      if (!reply) throw new Error(`Unexpected list call for ${spec.id}`);
      return reply(spec);
    },
    async close(id) {
      host.closed.push(id);
    },
    async edit() {
      throw new Error("Unexpected edit");
    },
  };
  return host;
}

function useHost(host: NativeUiHost): () => void {
  return events.on(NATIVE_UI_CHANNEL, (data) => (data as NativeUiRequest).add(host));
}

function writeStash(text: string): { id: string; path: string } {
  const id = randomUUID();
  fixtureCount += 1;
  const stashedAt = new Date(Date.now() - fixtureCount * 1000).toISOString();
  const path = join(stashDir, `${stashedAt.replaceAll(":", "-")}-${id}.json`);
  const origin = { sessionId: SESSION_ID, sessionName: "Native Tests", workspaceName: "native-ui" };
  writeFileSync(
    path,
    `${JSON.stringify({ id, text, inputMode: "normal", stashedAt, origin, attachments: [], locked: false, preserved: false })}\n`,
    { mode: 0o600 },
  );
  return { id, path };
}

function context(overrides: Record<string, unknown> = {}) {
  const state = { editor: "", notices: [] as string[], tuiOpened: false };
  const ctx = {
    cwd: agentDir,
    mode: "tui",
    agent: { kind: "main" },
    sessionManager: { getSessionId: () => SESSION_ID },
    ui: {
      custom() {
        state.tuiOpened = true;
        return Promise.resolve(null);
      },
      confirm() {
        throw new Error("ctx.ui.confirm should not run");
      },
      notify(message: string) {
        state.notices.push(message);
      },
      getEditorText: () => state.editor,
      setEditorText(value: string) {
        state.editor = value;
      },
      ...overrides,
    },
  } as unknown as ExtensionContext;
  return { ctx, state };
}

beforeAll(async () => {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CONFIG_DIR = relative(homedir(), agentDir);
  // Test files share one module registry, so another file may already have frozen the agent dir.
  ({ refreshDirsFromEnv } = await import("@oh-my-pi/pi-utils"));
  refreshDirsFromEnv();
  // Import after setting the agent dir so the plugin never touches the user's stash.
  const { default: promptStash } = await import("../extensions/prompt-stash.ts");
  await promptStash({
    events,
    on(event: string, handler: typeof sessionStart) {
      if (event === "session_start") sessionStart = handler;
    },
    registerShortcut() {},
    registerCommand(name: string, command: typeof stashCommand) {
      if (name === "stash") stashCommand = command;
    },
  } as unknown as ExtensionAPI);
  // session_start points the plugin at this bus.
  await sessionStart({}, {
    cwd: agentDir, mode: "tui", agent: { kind: "main" }, ui: { setEditorComponent() {} },
  } as unknown as ExtensionContext);
});

beforeEach(() => {
  listeners.clear();
  rmSync(stashDir, { recursive: true, force: true });
  mkdirSync(stashDir, { mode: 0o700 });
});

afterAll(() => {
  listeners.clear();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
  else process.env.PI_CONFIG_DIR = previousConfigDir;
  refreshDirsFromEnv();
  rmSync(agentDir, { recursive: true, force: true });
});

test("collectNativeHost returns undefined without a listener", () => {
  expect(collectNativeHost(undefined)).toBeUndefined();
  expect(collectNativeHost(events)).toBeUndefined();
});

test("a restore event restores the stash and closes the browser", async () => {
  const { id } = writeStash("restore me natively");
  const host = fakeHost([() => ({ type: "action", action: "restore", item: id, query: "", scope: "all" })]);
  useHost(host);
  const { ctx, state } = context();
  await stashCommand.handler("", ctx);
  expect(state.tuiOpened).toBeFalse();
  expect(state.editor).toBe("restore me natively");
  expect(host.specs).toHaveLength(1);
  expect(host.specs[0]).toMatchObject({ id: "ohmystash.browser", title: "OhMyStash", scope: "all", preview: true });
  expect(host.specs[0]!.items[0]).toMatchObject({ id, title: "restore me natively", scopes: ["current", "all"] });
  expect(host.closed).toEqual(["ohmystash.browser"]);
});

test("lock keeps the browser up and lists again with the same query, scope and selection", async () => {
  const { id, path } = writeStash("lock me natively");
  const host = fakeHost([
    () => ({ type: "action", action: "lock", item: id, query: "lock", scope: "current" }),
    () => ({ type: "cancel", query: "lock", scope: "current" }),
  ]);
  useHost(host);
  const { ctx, state } = context();
  await stashCommand.handler("", ctx);
  expect(JSON.parse(readFileSync(path, "utf8")).locked).toBeTrue();
  expect(state.notices).toContain("Stash locked");
  expect(host.specs).toHaveLength(2);
  expect(host.specs[1]).toMatchObject({ id: "ohmystash.browser", query: "lock", scope: "current", selected: id });
  expect(host.specs[1]!.items[0]!.tags).toContain("locked");
  expect(host.specs[1]!.items[0]!.marks).toContain("lock.fill");
  expect(host.closed).toEqual(["ohmystash.browser"]);
});

test("a stash added elsewhere lists again in place and the earlier call's cancel is ignored", async () => {
  writeStash("first native");
  let added: { id: string; path: string } | undefined;
  let settleFirst: ((event: NativeListEvent) => void) | undefined;
  const host = fakeHost([
    () => {
      // Harrier answers the open call with a cancel when the list is sent again with its id.
      const { promise, resolve } = Promise.withResolvers<NativeListEvent>();
      settleFirst = resolve;
      added = writeStash("added elsewhere natively");
      return promise;
    },
    () => {
      settleFirst!({ type: "cancel", query: "nat", scope: "current" });
      return { type: "action", action: "lock", item: added!.id, query: "nat", scope: "current" };
    },
    () => ({ type: "cancel", query: "nat", scope: "current" }),
  ]);
  useHost(host);
  const { ctx } = context();
  await stashCommand.handler("", ctx);
  expect(host.specs).toHaveLength(3);
  expect(host.specs[1]!.items.map((item) => item.id)).toContain(added!.id);
  // The refresh leaves the user's search, scope and selection to the host.
  expect(host.specs[1]!.query).toBeUndefined();
  expect(host.specs[1]!.scope).toBeUndefined();
  expect(host.specs[1]!.selected).toBeUndefined();
  expect(JSON.parse(readFileSync(added!.path, "utf8")).locked).toBeTrue();
});

test("delete uses the host's confirmation instead of ctx.ui.confirm", async () => {
  const kept = writeStash("keep me");
  const gone = writeStash("delete me natively");
  const host = fakeHost([
    () => ({ type: "action", action: "delete", item: gone.id, query: "", scope: "all" }),
    () => ({ type: "cancel", query: "", scope: "all" }),
  ]);
  useHost(host);
  const { ctx, state } = context();
  await stashCommand.handler("", ctx);
  expect(existsSync(gone.path)).toBeFalse();
  expect(existsSync(kept.path)).toBeTrue();
  expect(state.notices).toContain("Deleted stashed prompt");
  expect(host.specs[1]!.items.map((item) => item.id)).toEqual([kept.id]);
  expect(host.closed).toEqual(["ohmystash.browser"]);
});

test("a host that rejects the first list falls back to the TUI browser", async () => {
  writeStash("fallback");
  const host = fakeHost([() => Promise.reject(new Error("no window"))]);
  useHost(host);
  const { ctx, state } = context();
  await stashCommand.handler("", ctx);
  expect(host.specs).toHaveLength(1);
  expect(state.tuiOpened).toBeTrue();
  expect(state.notices).toEqual([]);
});

// A ctx whose terminal overlay answers with `tuiAnswer`, and counts how often it opened.
function pickerCtx(tuiAnswer: string | undefined) {
  const state = { opened: 0 };
  const ctx = {
    ui: {
      custom: async () => {
        state.opened += 1;
        return tuiAnswer;
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, state };
}

test("selectOption with events uses a native host's pick and closes the list", async () => {
  const host = fakeHost([(spec) => ({ type: "action", action: "select", item: spec.items[2]!.id, query: "" })]);
  const stop = useHost(host);
  try {
    const { ctx, state } = pickerCtx("terminal");
    const picked = await selectOption(ctx, "Pick", ["Red", "Green", "Blue"], undefined, {
      selected: "Green",
      native: { events, id: "test.colors" },
    });
    expect(picked).toBe("Blue");
    expect(state.opened).toBe(0);
    expect(host.specs[0]).toMatchObject({ id: "test.colors", title: "Pick", selected: "1" });
    expect(host.specs[0]!.items.map((item) => item.title)).toEqual(["Red", "Green", "Blue"]);
    expect(host.closed).toEqual(["test.colors"]);
  } finally {
    stop();
  }
});

test("selectOption with events resolves undefined when the host cancels", async () => {
  const host = fakeHost([() => ({ type: "cancel", query: "" })]);
  const stop = useHost(host);
  try {
    const { ctx, state } = pickerCtx("terminal");
    expect(await selectOption(ctx, "Pick", ["Red"], undefined, { native: { events, id: "test.cancel" } })).toBeUndefined();
    expect(state.opened).toBe(0);
  } finally {
    stop();
  }
});

test("selectOption with events falls back to the terminal when no host answers or the host fails", async () => {
  const none = pickerCtx("terminal");
  expect(await selectOption(none.ctx, "Pick", ["Red"], undefined, { native: { events, id: "test.none" } })).toBe("terminal");
  expect(none.state.opened).toBe(1);

  const stop = useHost(fakeHost([]));
  try {
    const failed = pickerCtx("terminal");
    expect(await selectOption(failed.ctx, "Pick", ["Red"], undefined, { native: { events, id: "test.fail" } })).toBe("terminal");
    expect(failed.state.opened).toBe(1);
  } finally {
    stop();
  }
});
