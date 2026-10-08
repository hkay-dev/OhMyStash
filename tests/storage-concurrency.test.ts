import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

type BrowserComponent = { handleInput(data: string): void; render(width: number): string[] };
type BrowserFactory = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: (value: unknown) => void,
) => BrowserComponent;
type Notice = { message: string; type?: string };

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousConfigDir = process.env.PI_CONFIG_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "oms-storage-concurrency-test-"));
const stashDir = join(agentDir, "prompt-stash");
const TEST_THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const DOWN = "\u001b[B";
const ESCAPE = "\u001b";
let refreshDirsFromEnv: () => void;
let restoreEditors: () => void;
let stashCommand: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void };
let refreshConfig: (event: unknown, ctx: ExtensionContext) => Promise<void>;

function stash(sessionId: string, text: string, ageMs: number) {
  const id = randomUUID();
  const stashedAt = new Date(Date.now() - ageMs).toISOString();
  const payload = `${JSON.stringify({
    id,
    text,
    inputMode: "normal",
    stashedAt,
    origin: { sessionId },
    attachments: [],
    locked: false,
    preserved: false,
  }, null, 2)}\n`;
  return {
    payload,
    path: join(stashDir, `${stashedAt.replaceAll(":", "-")}-${id}.json`),
    tempPath: join(stashDir, `.${id}.tmp`),
  };
}

// Crash leftovers are older than any write a live session could still be finishing.
function abandon(path: string): void {
  const crashedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(path, crashedAt, crashedAt);
}

function sessionStashes(sessionId: string) {
  return readdirSync(stashDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(stashDir, name), "utf8")))
    .filter((entry) => entry.origin?.sessionId === sessionId);
}

async function useSettings(settings: Record<string, unknown>): Promise<void> {
  mkdirSync(join(agentDir, ".omp"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(agentDir, ".omp", "plugin-overrides.json"),
    JSON.stringify({ settings: { "@hkay-dev/ohmystash": settings } }),
    { mode: 0o600 },
  );
  await refreshConfig({}, { cwd: agentDir } as ExtensionContext);
}

// Opens the browser for one chat, sends keys to the first view, and closes every later view.
async function browse(
  sessionId: string,
  keys: string[],
  ui: { confirm?: () => boolean; editor?: () => string } = {},
) {
  const notices: Notice[] = [];
  const frames: string[] = [];
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      custom(factory: BrowserFactory) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = factory(
          { terminal: { rows: 60 }, requestRender() {}, stop() {}, start() {} },
          TEST_THEME,
          undefined,
          resolve,
        );
        frames.push(component.render(120).join("\n"));
        for (const key of frames.length === 1 ? keys : [ESCAPE]) component.handleInput(key);
        return promise;
      },
      confirm: async () => ui.confirm?.() ?? true,
      editor: async () => ui.editor?.(),
      getEditorText: () => "",
      notify(message: string, type?: string) {
        notices.push({ message, type });
      },
    },
  } as unknown as ExtensionContext;
  await stashCommand.handler("", context);
  return { frames, notices };
}

beforeAll(async () => {
  // SDK modules capture the agent dir when they first load, so they are imported only after it
  // points at this temp dir. Bun shares modules across test files, so rebind it in case one loaded.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // getPluginSettings also merges <config root>/plugins/omp-plugins.lock.json, and the config root is
  // os.homedir() joined with PI_CONFIG_DIR. Bun reads HOME only at startup, so point PI_CONFIG_DIR here.
  process.env.PI_CONFIG_DIR = relative(homedir(), agentDir);
  ({ refreshDirsFromEnv } = await import("@oh-my-pi/pi-utils"));
  refreshDirsFromEnv();
  mkdirSync(stashDir, { mode: 0o700 });
  const externalEditor = await import("@oh-my-pi/pi-coding-agent/utils/external-editor");
  // Edits go through ctx.ui.editor, never a real external editor.
  const editorCommand = spyOn(externalEditor, "getEditorCommand").mockImplementation(() => undefined);
  const editor = spyOn(externalEditor, "openInEditor").mockImplementation(async () => {
    throw new Error("External editors are disabled in storage tests");
  });
  restoreEditors = () => {
    editorCommand.mockRestore();
    editor.mockRestore();
  };
  const { default: promptStash } = await import("../extensions/prompt-stash.ts");
  await promptStash({
    on(event: string, handler: typeof refreshConfig) {
      if (event === "session_start") refreshConfig = handler;
    },
    registerShortcut() {},
    registerCommand(name: string, command: typeof stashCommand) {
      if (name === "stash") stashCommand = command;
    },
  } as unknown as ExtensionAPI);
  await useSettings({});
});

beforeEach(() => {
  for (const name of readdirSync(stashDir)) rmSync(join(stashDir, name), { recursive: true, force: true });
});

afterAll(async () => {
  restoreEditors();
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

test("never claims another session's unrenamed save temp, but still recovers an abandoned one", async () => {
  for (const key of ["l", "d", "e"]) {
    const sessionId = randomUUID();
    const live = stash(sessionId, `save still being renamed ${key}`, 60_000);
    writeFileSync(live.tempPath, live.payload, { mode: 0o600 });

    await browse(sessionId, [key], { editor: () => `edit made beside a live save ${key}` });

    expect(readFileSync(live.tempPath, "utf8")).toBe(live.payload);
    expect(existsSync(live.path)).toBeFalse();
    if (key === "e") {
      expect(sessionStashes(sessionId).map((entry) => entry.text)).toEqual([
        `edit made beside a live save ${key}`,
      ]);
    }
    // The saving session can still publish its own temp afterwards.
    renameSync(live.tempPath, live.path);
    expect(readFileSync(live.path, "utf8")).toBe(live.payload);
  }

  const sessionId = randomUUID();
  const crashed = stash(sessionId, "save interrupted before rename", 60_000);
  writeFileSync(crashed.tempPath, crashed.payload, { mode: 0o600 });
  abandon(crashed.tempPath);

  await browse(sessionId, ["l"]);

  expect(existsSync(crashed.tempPath)).toBeFalse();
  expect(JSON.parse(readFileSync(crashed.path, "utf8"))).toMatchObject({
    text: "save interrupted before rename",
    locked: true,
  });
});

test("does not delete a stash while another session holds its replacement reservation", async () => {
  const sessionId = randomUUID();
  const target = stash(sessionId, "delete while replaced", 60_000);
  const edited = target.payload.replace("delete while replaced", "replacement in progress");
  writeFileSync(target.path, target.payload, { mode: 0o600 });

  await browse(sessionId, ["d"], {
    confirm() {
      // Another session starts replacing the stash after this browser loaded it.
      writeFileSync(target.tempPath, edited, { mode: 0o600 });
      return true;
    },
  });

  expect(readFileSync(target.path, "utf8")).toBe(target.payload);
  expect(readFileSync(target.tempPath, "utf8")).toBe(edited);
  renameSync(target.tempPath, target.path);
  expect(readFileSync(target.path, "utf8")).toBe(edited);
});

test("retention keeps an expired stash while another session replaces it", async () => {
  const sessionId = randomUUID();
  const expired = stash(sessionId, "expired while replaced", 3 * 86_400_000);
  const edited = expired.payload.replace("expired while replaced", "locked by another session");
  writeFileSync(expired.path, expired.payload, { mode: 0o600 });
  writeFileSync(expired.tempPath, edited, { mode: 0o600 });

  try {
    await useSettings({ "Retention days": 1 });
    expect(readFileSync(expired.path, "utf8")).toBe(expired.payload);
    expect(readFileSync(expired.tempPath, "utf8")).toBe(edited);

    rmSync(expired.tempPath);
    await useSettings({ "Retention days": 1 });
    expect(existsSync(expired.path)).toBeFalse();
  } finally {
    await useSettings({});
  }
});

test("surfaces an orphaned edit as its own stash and frees the original for changes", async () => {
  const sessionId = randomUUID();
  // The conflict copy is dated by the crashed edit, which came after the stash.
  const original = stash(sessionId, "original before the crash", 3 * 3_600_000);
  writeFileSync(original.path, original.payload, { mode: 0o600 });
  // replaceEntry fsynced this edit, then crashed before renaming it over the original.
  writeFileSync(
    original.tempPath,
    original.payload.replace("original before the crash", "edit fsynced before the crash"),
    { mode: 0o600 },
  );
  abandon(original.tempPath);

  const { frames, notices } = await browse(sessionId, [DOWN, "l"]);

  expect(frames[0]).toContain("edit fsynced before the crash");
  expect(notices.filter((notice) => notice.type === "error")).toEqual([]);
  expect(existsSync(original.tempPath)).toBeFalse();
  expect(JSON.parse(readFileSync(original.path, "utf8"))).toMatchObject({
    text: "original before the crash",
    locked: true,
  });
  expect(sessionStashes(sessionId).map((entry) => entry.text).sort()).toEqual([
    "edit fsynced before the crash",
    "original before the crash",
  ]);
});

test("converts an orphaned edit into one conflict copy however often it is loaded", async () => {
  const sessionId = randomUUID();
  const original = stash(sessionId, "original before the crash", 3 * 3_600_000);
  writeFileSync(original.path, original.payload, { mode: 0o600 });
  writeFileSync(
    original.tempPath,
    original.payload.replace("original before the crash", "edit fsynced before the crash"),
    { mode: 0o600 },
  );
  abandon(original.tempPath);
  // A second name keeps the orphan's file, so it can come back as if its release had failed.
  const unreleased = join(agentDir, "unreleased-orphan");
  linkSync(original.tempPath, unreleased);

  await browse(sessionId, [ESCAPE]);
  linkSync(unreleased, original.tempPath);
  rmSync(unreleased);
  const { notices } = await browse(sessionId, [ESCAPE]);

  expect(notices.filter((notice) => notice.type !== "info")).toEqual([]);
  expect(existsSync(original.tempPath)).toBeFalse();
  expect(sessionStashes(sessionId).map((entry) => entry.text).sort()).toEqual([
    "edit fsynced before the crash",
    "original before the crash",
  ]);
});

test("publishes a conflict copy that a crash left unpublished, then frees its stash", async () => {
  const sessionId = randomUUID();
  const original = stash(sessionId, "original before the crash", 3 * 3_600_000);
  writeFileSync(original.path, original.payload, { mode: 0o600 });
  writeFileSync(
    original.tempPath,
    original.payload.replace("original before the crash", "edit fsynced before the crash"),
    { mode: 0o600 },
  );
  abandon(original.tempPath);
  const unreleased = join(agentDir, "unreleased-orphan");
  linkSync(original.tempPath, unreleased);
  await browse(sessionId, [ESCAPE]);
  // Rebuild what a crash between writing the copy's temp and publishing it leaves behind.
  const copyName = readdirSync(stashDir).find((name) => name.endsWith(".preserved.json"))!;
  const copyId = JSON.parse(readFileSync(join(stashDir, copyName), "utf8")).id;
  const copyTemp = join(stashDir, `.${copyId}.tmp`);
  renameSync(join(stashDir, copyName), copyTemp);
  abandon(copyTemp);
  linkSync(unreleased, original.tempPath);
  rmSync(unreleased);

  // The copy is dated by the crashed edit, so it lists first and the stash second.
  const { notices } = await browse(sessionId, [DOWN, "d"]);

  expect(notices.filter((notice) => notice.type === "error")).toEqual([]);
  expect(existsSync(original.path)).toBeFalse();
  expect(readdirSync(stashDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  expect(sessionStashes(sessionId)).toEqual([
    expect.objectContaining({ id: copyId, text: "edit fsynced before the crash", preserved: true }),
  ]);
});

test("releases an orphaned identical temp without duplicating its stash", async () => {
  const sessionId = randomUUID();
  const original = stash(sessionId, "identical orphan", 3_600_000);
  writeFileSync(original.path, original.payload, { mode: 0o600 });
  writeFileSync(original.tempPath, original.payload, { mode: 0o600 });
  abandon(original.tempPath);

  const { notices } = await browse(sessionId, ["l"]);

  expect(notices.filter((notice) => notice.type === "error")).toEqual([]);
  expect(existsSync(original.tempPath)).toBeFalse();
  expect(sessionStashes(sessionId)).toEqual([
    expect.objectContaining({ text: "identical orphan", locked: true }),
  ]);
});

test("releases an empty reservation left by a crash before any bytes were written", async () => {
  const sessionId = randomUUID();
  const original = stash(sessionId, "reserved before the crash", 3_600_000);
  writeFileSync(original.path, original.payload, { mode: 0o600 });
  writeFileSync(original.tempPath, "", { mode: 0o600 });
  abandon(original.tempPath);

  const { notices } = await browse(sessionId, ["l"]);

  expect(notices.filter((notice) => notice.type !== "info")).toEqual([]);
  expect(existsSync(original.tempPath)).toBeFalse();
  expect(JSON.parse(readFileSync(original.path, "utf8")).locked).toBeTrue();
});

test("does not report another session's empty reservation as an omitted stash", async () => {
  const sessionId = randomUUID();
  const target = stash(sessionId, "stash another session is changing", 60_000);
  writeFileSync(target.path, target.payload, { mode: 0o600 });
  // A delete or replace in another session holds this reservation before writing any bytes.
  writeFileSync(target.tempPath, "", { mode: 0o600 });

  const { notices } = await browse(sessionId, [ESCAPE]);

  expect(notices.filter((notice) => notice.type !== "info")).toEqual([]);
  expect(readFileSync(target.tempPath, "utf8")).toBe("");
});

test("deleting a stash also deletes its recovery hard link", async () => {
  const sessionId = randomUUID();
  const target = stash(sessionId, "stash with a recovery hard link", 60_000);
  writeFileSync(target.path, target.payload, { mode: 0o600 });
  // A crash between linking the recovery temp and unlinking it leaves this alias behind.
  linkSync(target.path, target.tempPath);

  const { notices } = await browse(sessionId, ["d"]);

  expect(notices.filter((notice) => notice.type === "error")).toEqual([]);
  expect(existsSync(target.path)).toBeFalse();
  expect(existsSync(target.tempPath)).toBeFalse();
});

test("sets aside a torn temp so its stash can still be deleted", async () => {
  const sessionId = randomUUID();
  const target = stash(sessionId, "stash beside a torn edit", 3_600_000);
  const torn = target.payload.slice(0, 40);
  writeFileSync(target.path, target.payload, { mode: 0o600 });
  // A crash tore this replacement before all of its bytes were written.
  writeFileSync(target.tempPath, torn, { mode: 0o600 });
  abandon(target.tempPath);

  const { notices } = await browse(sessionId, ["d"]);

  expect(notices.filter((notice) => notice.type === "error")).toEqual([]);
  expect(existsSync(target.path)).toBeFalse();
  expect(existsSync(target.tempPath)).toBeFalse();
  expect(readFileSync(`${target.tempPath}.orphan`, "utf8")).toBe(torn);
});

test("delete-all keeps a stash another session is changing and still deletes the rest", async () => {
  const sessionId = randomUUID();
  const busy = stash(sessionId, "stash another session starts changing", 60_000);
  const idle = stash(sessionId, "stash nobody else touches", 120_000);
  writeFileSync(busy.path, busy.payload, { mode: 0o600 });
  writeFileSync(idle.path, idle.payload, { mode: 0o600 });

  const { notices } = await browse(sessionId, ["D"], {
    confirm() {
      // Another session reserves the newest stash after this browser loaded it.
      writeFileSync(busy.tempPath, "", { mode: 0o600 });
      return true;
    },
  });

  // Only the delete-all summary is reported.
  expect(notices.map((notice) => notice.type)).toEqual(["info"]);
  expect(readFileSync(busy.path, "utf8")).toBe(busy.payload);
  expect(existsSync(idle.path)).toBeFalse();
});

test("keeps an edit that would push older stashes out of the load budget as a preserved copy", async () => {
  const sessionId = randomUUID();
  const filler = "x".repeat(1_000_000);
  for (let index = 0; index < 16; index += 1) {
    const older = stash(sessionId, `${index} ${filler}`, (index + 2) * 60_000);
    writeFileSync(older.path, older.payload, { mode: 0o600 });
  }
  const target = stash(sessionId, "small stash about to grow", 60_000);
  writeFileSync(target.path, target.payload, { mode: 0o600 });
  const edited = "y".repeat(1_000_000);

  const edit = await browse(sessionId, ["e"], { editor: () => edited });

  expect(edit.notices.map((notice) => notice.type)).toEqual(["warning"]);
  expect(readFileSync(target.path, "utf8")).toBe(target.payload);
  const reload = await browse(sessionId, [ESCAPE]);
  expect(reload.notices.filter((notice) => notice.type === "warning")).toEqual([]);
  const stashes = sessionStashes(sessionId);
  expect(stashes).toHaveLength(18);
  expect(stashes.filter((entry) => entry.preserved)).toEqual([
    expect.objectContaining({ text: edited }),
  ]);
});

test("unlocks and deletes a locked stash while storage is over the quota", async () => {
  const sessionId = randomUUID();
  const filler = "x".repeat(1_000_000);
  for (let index = 0; index < 17; index += 1) {
    const older = stash(sessionId, `${index} ${filler}`, (index + 2) * 60_000);
    writeFileSync(older.path, older.payload, { mode: 0o600 });
  }
  const target = stash(sessionId, "locked stash past the quota", 60_000);
  writeFileSync(target.path, target.payload.replace('"locked": false', '"locked": true'), { mode: 0o600 });

  const unlock = await browse(sessionId, ["l"]);

  expect(unlock.notices.filter((notice) => notice.type === "error")).toEqual([]);
  expect(JSON.parse(readFileSync(target.path, "utf8")).locked).toBeFalse();
  const remove = await browse(sessionId, ["d"]);
  expect(remove.notices.filter((notice) => notice.type === "error")).toEqual([]);
  expect(existsSync(target.path)).toBeFalse();
});
