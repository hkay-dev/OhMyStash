import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components";

const agentDir = mkdtempSync(join(tmpdir(), "prompt-stash-test-"));
const TEST_SESSION_ID = randomUUID();
const TEST_SESSION_STARTED_AT = "2026-07-28T12:00:00.000Z";
const TEST_SESSION_MANAGER = {
  getSessionId: () => TEST_SESSION_ID,
  getSessionName: () => "OhMyStash Tests",
  getHeader: () => ({
    type: "session" as const,
    id: TEST_SESSION_ID,
    timestamp: TEST_SESSION_STARTED_AT,
    cwd: agentDir,
  }),
};
const TEST_ORIGIN = {
  sessionId: TEST_SESSION_ID,
  sessionName: "OhMyStash Tests",
  sessionStartedAt: TEST_SESSION_STARTED_AT,
  workspaceName: "ohmystash-tests",
};
let stashCommand: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void };
let stashShortcut: { handler: (ctx: ExtensionContext) => Promise<void> | void };
let refreshConfig: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
const TEST_THEME = {
  isLight: false,
  getFgAnsi: () => "\u001b[38;2;200;200;200m",
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  symbol: (name: string) => name,
};

function browserComponent(
  factory: Function,
  done: Function,
  terminal = { rows: 60, write: (_data: string) => {} },
) {
  return factory({ terminal, requestRender() {}, resetDisplay() {} }, TEST_THEME, undefined, done);
}

const projectConfigDir = join(agentDir, ".omp");

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(projectConfigDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(projectConfigDir, "plugin-overrides.json"),
    JSON.stringify({ settings: { "@hkay-dev/ohmystash": settings } }),
    { mode: 0o600 },
  );
}
let fixtureClock = Date.now() + 60_000;

function writeStashFixture(
  text: string,
  origin: unknown = TEST_ORIGIN,
  inputMode: "normal" | "queue" = "normal",
) {
  const id = randomUUID();
  const stashedAt = new Date(fixtureClock += 1).toISOString();
  const path = join(
    agentDir,
    "prompt-stash",
    `${stashedAt.replaceAll(":", "-")}-${id}.json`,
  );
  writeFileSync(
    path,
    `${JSON.stringify({
      id,
      text,
      inputMode,
      stashedAt,
      ...(origin === null ? {} : { origin }),
      attachments: [],
      locked: false,
      preserved: false,
    })}\n`,
    { mode: 0o600 },
  );
  return { id, path, stashedAt };
}

beforeAll(async () => {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const id = randomUUID();
  const stashedAt = new Date().toISOString();
  const stashDir = join(agentDir, "prompt-stash");
  mkdirSync(stashDir, { mode: 0o700 });
  writeFileSync(
    join(stashDir, `${stashedAt.replaceAll(":", "-")}-${id}.json`),
    `${JSON.stringify({ id, text: "test prompt", inputMode: "normal", stashedAt, origin: TEST_ORIGIN })}\n`,
    { mode: 0o600 },
  );
  const longId = randomUUID();
  const longStashedAt = new Date(Date.now() + 1_000).toISOString();
  writeFileSync(
    join(stashDir, `${longStashedAt.replaceAll(":", "-")}-${longId}.json`),
    `${JSON.stringify({
      id: longId,
      text: Array.from({ length: 100 }, (_, index) => `preview line ${index + 1}`).join("\n"),
      inputMode: "normal",
      stashedAt: longStashedAt,
      origin: TEST_ORIGIN,
    })}\n`,
    { mode: 0o600 },
  );
  writeSettings({ "Dim background": true, "Time format": "12-hour clock" });
  // Import after setting the agent-dir override so the test never touches the user's stash.
  const { default: promptStash } = await import("../extensions/prompt-stash.ts");
  const api = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) {
      if (event === "session_start") refreshConfig = handler;
    },
    registerShortcut(key: string, shortcut: typeof stashShortcut) {
      if (key === "alt+s") stashShortcut = shortcut;
    },
    registerCommand(name: string, command: typeof stashCommand) {
      if (name === "stash") stashCommand = command;
    },
  } as unknown as ExtensionAPI;
  await promptStash(api);
  await refreshConfig?.({}, { cwd: agentDir } as ExtensionContext);
});

afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

test("restores the terminal writer when browser setup throws", async () => {
  for (const failure of ["custom", "render"] as const) {
    const writes: string[] = [];
    const originalWrite = (data: string) => writes.push(data);
    const terminal = { rows: 30, write: originalWrite };
    let renderCalls = 0;
    let resetCalls = 0;
    const notifications: string[] = [];
    const context = {
      cwd: process.cwd(),
      mode: "tui",
      sessionManager: TEST_SESSION_MANAGER,
      ui: {
        custom(factory: Function) {
          factory(
            {
              terminal,
              requestRender() {
                renderCalls += 1;
                if (failure === "render" && renderCalls === 1) throw new Error("render failed");
              },
              resetDisplay() {
                resetCalls += 1;
              },
            },
            TEST_THEME,
            undefined,
            () => {},
          );
          throw new Error("custom failed");
        },
        getEditorText: () => "",
        notify(message: string) {
          notifications.push(message);
        },
      },
    } as unknown as ExtensionContext;

    await stashCommand.handler("", context);

    expect(terminal.write).toBe(originalWrite);
    expect(writes).toContain("\x1b[0m");
    expect(resetCalls).toBe(1);
    expect(notifications.at(-1)).toStartWith("OMS failed:");
  }
});

test("fully resets and repaints the terminal after a normal close", async () => {
  const writes: string[] = [];
  const originalWrite = (data: string) => writes.push(data);
  const terminal = { rows: 30, write: originalWrite };
  let resetCalls = 0;
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = factory(
          {
            terminal,
            requestRender() {},
            resetDisplay() {
              resetCalls += 1;
            },
          },
          TEST_THEME,
          undefined,
          resolve,
        );
        component.handleInput("\u001b");
        return promise;
      },
      getEditorText: () => "",
      notify() {},
    },
  } as unknown as ExtensionContext;

  await stashCommand.handler("", context);

  expect(terminal.write).toBe(originalWrite);
  expect(writes).toContain("\x1b[0m");
  expect(resetCalls).toBe(1);
});

test("uses the doubled default browser height", async () => {
  let renderedHeight = 0;
  const originalWrite = () => {};
  const terminal = { rows: 100, write: originalWrite };
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      custom(factory: Function) {
        const component = browserComponent(factory, () => {}, terminal);
        renderedHeight = component.render(120).length;
        return Promise.resolve(null);
      },
      getEditorText: () => "",
      notify() {},
    },
  } as unknown as ExtensionContext;

  await stashCommand.handler("", context);

  expect(renderedHeight).toBe(42);
  expect(terminal.write).toBe(originalWrite);
});

test("search Enter restores and q queues without an apply step", async () => {
  for (const [key, expected] of [
    ["\r", "test prompt"],
    ["q", "/queue test prompt"],
  ] as const) {
    let editor = "";
    const terminal = { rows: 40, write: () => {} };
    const context = {
      cwd: agentDir,
      mode: "tui",
      sessionManager: TEST_SESSION_MANAGER,
      ui: {
        custom(factory: Function) {
          const { promise, resolve } = Promise.withResolvers<unknown>();
          const component = browserComponent(factory, resolve, terminal);
          component.handleInput("/");
          component.handleInput("test");
          component.handleInput(key);
          return promise;
        },
        getEditorText: () => "",

        setEditorText(value: string) {
          editor = value;
        },
        notify() {},
      },
    } as unknown as ExtensionContext;

    await stashCommand.handler("", context);
    expect(editor).toBe(expected);
  }
});

test("submits repeated Shift+Q actions as ordered slash queue commands", async () => {
  const sessionManager = { ...TEST_SESSION_MANAGER };
  const submissions: string[] = [];
  let editor!: CustomEditor;
  let browserCalls = 0;
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager,
    ui: {
      setEditorComponent(factory: Function) {
        editor = factory(
          { enableScopedInputRender() {} },
          { symbols: {}, borderColor: (text: string) => text },
          {},
        );
        editor.onSubmit = (text: string) => {
          submissions.push(text);
        };
      },
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = browserComponent(factory, resolve, { rows: 40, write: () => {} });
        if (browserCalls === 0) {
          component.handleInput("/");
          component.handleInput("test prompt");
          component.handleInput("Q");
        } else if (browserCalls === 1) {
          component.handleInput("Q");
        } else {
          component.handleInput("\u001b");
          component.handleInput("\u001b");
        }
        browserCalls += 1;
        return promise;
      },
      getEditorText: () => editor.getText(),
      setEditorText(value: string) {
        editor.setText(value);
      },
      pasteToEditor(value: string) {
        editor.handleInput(`\u001b[200~${value}\u001b[201~`);
      },
      notify() {},
    },
  } as unknown as ExtensionContext;
  await refreshConfig?.({}, context);

  await stashCommand.handler("", context);

  expect(browserCalls).toBe(3);
  expect(submissions).toEqual(["/queue test prompt", "/queue test prompt"]);

  for (const text of ["unfinished draft", "/queue unfinished draft", ""]) {
    const images = text ? [] : [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
    editor.setDraft(text, images);
    browserCalls = 0;
    submissions.length = 0;
    await stashCommand.handler("", context);
    expect(editor.getExpandedText()).toBe(text);
    expect(editor.pendingImages).toEqual(images);
    expect(submissions).toEqual([]);
  }
  editor.clearDraft();
});

test("protects image-only drafts during restore and stashes them with Alt+S", async () => {
  const sessionId = randomUUID();
  const fixture = writeStashFixture("image-only restore target", { ...TEST_ORIGIN, sessionId });
  let editor!: CustomEditor;
  let action = "\r";
  let calls = 0;
  const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
  const context = {
    cwd: agentDir, mode: "tui",
    sessionManager: { ...TEST_SESSION_MANAGER, getSessionId: () => sessionId },
    ui: {
      setEditorComponent(factory: Function) {
        editor = factory({}, { symbols: {}, borderColor: (text: string) => text }, {});
      },
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = browserComponent(factory, resolve);
        component.handleInput(calls++ === 0 ? action : "\u001b");
        return promise;
      },
      getEditorText: () => editor.getText(),
      notify() {},
    },
  } as unknown as ExtensionContext;
  try {
    await refreshConfig?.({}, context);
    editor.setDraft("", images);
    await stashCommand.handler("restore", context);
    expect(editor.pendingImages).toEqual(images);
    expect(editor.getExpandedText()).toBe("");
    for (action of ["\r", "q"]) {
      calls = 0;
      await stashCommand.handler("", context);
      expect(editor.pendingImages).toEqual(images);
      expect(editor.getExpandedText()).toBe("");
    }
    await stashShortcut.handler(context);
    expect(editor.pendingImages).toEqual([]);
    const saved = readdirSync(join(agentDir, "prompt-stash"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(agentDir, "prompt-stash", name), "utf8")))
      .find((entry) => entry.origin?.sessionId === sessionId && entry.id !== fixture.id);
    expect(saved?.attachments).toHaveLength(1);
    expect(saved?.text).toBe("");
  } finally {
    for (const name of readdirSync(join(agentDir, "prompt-stash"))) {
      if (!name.endsWith(".json")) continue;
      const path = join(agentDir, "prompt-stash", name);
      if (JSON.parse(readFileSync(path, "utf8")).origin?.sessionId === sessionId) rmSync(path);
    }
  }
});

test("search accepts d as query text until Tab selects the filtered result", async () => {
  let actionTriggered = false;
  let rendered = "";
  const terminal = { rows: 40, write: () => {} };
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      custom(factory: Function) {
        const component = browserComponent(factory, (action: unknown) => {
          actionTriggered = action !== null;
        }, terminal);
        component.handleInput("/");
        component.handleInput("d");
        rendered = component.render(120).join("\n");
        return Promise.resolve(null);
      },
      getEditorText: () => "",
      notify() {},
    },
  } as unknown as ExtensionContext;

  await stashCommand.handler("", context);

  expect(actionTriggered).toBeFalse();
  expect(rendered).toContain("/d");
  expect(rendered).toContain("Tab Select");
});

test("switches exact timestamps between 12-hour and 24-hour clocks", async () => {
  const notifications: string[] = [];
  let editor = "";
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      getEditorText: () => editor,
      setEditorText(value: string) {
        editor = value;
      },
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;

  await stashCommand.handler("restore", context);
  expect(notifications.at(-1)).toMatch(/\b(?:AM|PM)\b/i);

  writeSettings({ "Dim background": true, "Time format": "24-hour clock" });
  await refreshConfig?.({}, { cwd: agentDir } as ExtensionContext);
  editor = "";
  await stashCommand.handler("restore", context);

  expect(notifications.at(-1)).not.toMatch(/\b(?:AM|PM)\b/i);
  expect(notifications.at(-1)).toMatch(/\d{2}:\d{2}:\d{2}/);
  writeSettings({ "Dim background": true, "Time format": "12-hour clock" });
  await refreshConfig?.({}, { cwd: agentDir } as ExtensionContext);
});

test("edits a stash with OMP's editor and honors an explicit editor command", async () => {
  const previousVisual = process.env.VISUAL;
  const previousEditor = process.env.EDITOR;
  delete process.env.VISUAL;
  delete process.env.EDITOR;
  let browserCalls = 0;
  let editorCalls = 0;
  let stopCalls = 0;
  let startCalls = 0;
  let editedValue = "edited test prompt";
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = factory(
          {
            terminal: { rows: 60, write: () => {} },
            requestRender() {},
            resetDisplay() {},
            stop() {
              stopCalls += 1;
            },
            start() {
              startCalls += 1;
            },
          },
          TEST_THEME,
          undefined,
          resolve,
        );
        if (browserCalls === 0) {
          component.handleInput("/");
          component.handleInput("test prompt");
          component.handleInput("\t");
          component.handleInput("e");
        } else {
          component.handleInput("\u001b");
          component.handleInput("\u001b");
        }
        browserCalls += 1;
        return promise;
      },
      editor(_title: string, prefill: string) {
        editorCalls += 1;
        expect(prefill).toContain("test prompt");
        return Promise.resolve(editedValue);
      },
      getEditorText: () => "",
      notify() {},
    },
  } as unknown as ExtensionContext;

  try {
    writeSettings({
      "Dim background": true,
      "Time format": "12-hour clock",
      "Editor command": "",
    });
    await refreshConfig?.({}, { cwd: agentDir } as ExtensionContext);
    await stashCommand.handler("", context);
    expect(editorCalls).toBe(1);
    expect(stopCalls).toBe(0);
    expect(startCalls).toBe(0);
    expect(
      readdirSync(join(agentDir, "prompt-stash"))
        .filter((file) => file.endsWith(".json"))
        .map((file) => readFileSync(join(agentDir, "prompt-stash", file), "utf8"))
        .some((text) => text.includes("edited test prompt")),
    ).toBeTrue();

    browserCalls = 0;
    editorCalls = 0;
    editedValue = "should not be used";
    writeSettings({
      "Dim background": true,
      "Time format": "12-hour clock",
      "Editor command": "false",
    });
    await refreshConfig?.({}, { cwd: agentDir } as ExtensionContext);
    await stashCommand.handler("", context);
    expect(editorCalls).toBe(0);
    expect(stopCalls).toBe(1);
    expect(startCalls).toBe(1);
  } finally {
    if (previousVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = previousVisual;
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
    writeSettings({ "Dim background": true, "Time format": "12-hour clock" });
    await refreshConfig?.({}, { cwd: agentDir } as ExtensionContext);
  }
});

test("round-trips an OMP image plus a file-backed large paste and queues it with Shift+Q", async () => {
  const sessionManager = { ...TEST_SESSION_MANAGER };
  let editor!: CustomEditor;
  let browserCalls = 0;
  let browserMode: "restore" | "queue" = "restore";
  const notifications: string[] = [];
  const submittedQueuePrompts: string[] = [];
  const submittedQueueImages: string[][] = [];
  const editorTheme = {
    symbols: {},
    borderColor: (text: string) => text,
  };
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager,
    ui: {
      setEditorComponent(factory: Function) {
        editor = factory(
          {},
          editorTheme,
          {},
        );
        editor.onSubmit = (text: string) => {
          submittedQueuePrompts.push(text);
          submittedQueueImages.push(editor.pendingImages.map((image) => image.data));
          editor.clearDraft();
        };
      },
      get theme() {
        return { symbol: () => "img" };
      },
      getEditorText: () => editor.getText(),
      setEditorText(value: string) {
        editor.setText(value);
      },
      pasteToEditor(value: string) {
        editor.handleInput(`\u001b[200~${value}\u001b[201~`);
      },
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = browserComponent(factory, resolve, { rows: 80, write: () => {} });
        if (browserCalls === 0) {
          component.handleInput("/");
          component.handleInput("Large pasted prompt");
          component.handleInput(browserMode === "restore" ? "\r" : "Q");
        } else {
          component.handleInput("\u001b");
          component.handleInput("\u001b");
        }
        browserCalls += 1;
        return promise;
      },
      confirm: async () => false,
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;
  await refreshConfig?.({}, context);

  const imageData = Buffer.from("native image bytes").toString("base64");
  const largePaste = "large paste line\n".repeat(70_000);
  const originalText = `attachment [Image #1]\n${largePaste}`;
  editor.setText("attachment [Image #1]\n");
  editor.pendingImages = [{ type: "image", data: imageData, mimeType: "image/png", detail: "original" }];
  editor.pendingImageLinks = [undefined];
  editor.insertPaste(largePaste);

  await stashShortcut.handler(context);

  expect(editor.getText()).toBe("");
  const stashFiles = readdirSync(join(agentDir, "prompt-stash")).filter((file) =>
    file.endsWith(".json"),
  );
  const attachmentEntry = stashFiles
    .map((file) =>
      JSON.parse(readFileSync(join(agentDir, "prompt-stash", file), "utf8")) as {
        attachments?: Array<{ kind: string; ref: string }>;
        text: string;
      },
    )
    .find((entry) => entry.attachments?.length === 2);
  expect(attachmentEntry).toBeDefined();
  expect(attachmentEntry!.attachments!.map((attachment) => attachment.kind).sort()).toEqual([
    "body",
    "image",
  ]);
  expect(attachmentEntry!.text).toStartWith("[Large pasted prompt");

  let pasteMenuCalls = 0;
  editor.onLargePaste = () => {
    pasteMenuCalls += 1;
    return true;
  };

  browserCalls = 0;
  browserMode = "restore";
  await stashCommand.handler("", context);

  expect(pasteMenuCalls).toBe(0);
  expect(editor.getExpandedText()).toBe(originalText);
  expect(editor.pendingImages).toHaveLength(1);
  expect(editor.pendingImages[0]?.data).toBe(imageData);
  expect(editor.pendingImages[0]?.detail).toBe("original");
  const attachmentDir = join(agentDir, "prompt-stash", "attachments");
  const assetsBefore = readdirSync(attachmentDir).sort();
  await stashShortcut.handler(context);
  expect(editor.getText()).toBe("");
  expect(readdirSync(attachmentDir).sort()).toEqual(assetsBefore);

  submittedQueuePrompts.length = 0;
  submittedQueueImages.length = 0;
  browserCalls = 0;
  browserMode = "queue";
  await stashCommand.handler("", context);
  expect(browserCalls).toBe(2);
  expect(submittedQueuePrompts).toEqual([`/queue ${originalText.trim()}`]);
  expect(submittedQueueImages).toEqual([[imageData]]);
  expect(pasteMenuCalls).toBe(0);
  expect(
    readdirSync(join(agentDir, "prompt-stash")).filter((file) => file.endsWith(".json")),
  ).toHaveLength(stashFiles.length + 1);

  const imageRef = attachmentEntry!.attachments!.find((attachment) => attachment.kind === "image")!.ref;
  const imagePath = join(attachmentDir, imageRef.slice("sha256:".length));
  const imageBytes = readFileSync(imagePath);
  writeFileSync(imagePath, "corrupt", { mode: 0o600 });
  browserCalls = 0;
  browserMode = "restore";
  await stashCommand.handler("", context);
  expect(notifications.at(-1)).toStartWith("OMS failed:");
  expect(editor.getText()).toBe("");
  writeFileSync(imagePath, imageBytes, { mode: 0o600 });

  const imageMarkers = Array.from({ length: 64 }, (_, index) => `[Image #${index + 1}]`).join(" ");
  const image = { type: "image" as const, data: imageData, mimeType: "image/png" };
  editor.setText(imageMarkers);
  editor.pendingImages = Array.from({ length: 64 }, () => image);
  editor.pendingImageLinks = Array.from({ length: 64 }, () => undefined);
  await stashShortcut.handler(context);
  expect(editor.getText()).toBe("");

  editor.setText(`${imageMarkers} [Image #65]`);
  editor.pendingImages = Array.from({ length: 65 }, () => image);
  editor.pendingImageLinks = Array.from({ length: 65 }, () => undefined);
  await stashShortcut.handler(context);
  expect(notifications.at(-1)).toContain("at most 64 attachments");
  expect(editor.getText()).toContain("[Image #65]");
  editor.clearDraft();
});


test("editing a file-backed attachment stash preserves image refs and lock state", async () => {
  const previousVisual = process.env.VISUAL;
  const previousEditor = process.env.EDITOR;
  delete process.env.VISUAL;
  delete process.env.EDITOR;
  let browserCalls = 0;
  let originalPrefill = "";
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = browserComponent(factory, resolve, { rows: 80, write: () => {} });
        if (browserCalls === 0) {
          component.handleInput("/");
          component.handleInput("Large pasted prompt");
          component.handleInput("\t");
          component.handleInput("e");
        } else {
          component.handleInput("\u001b");
          component.handleInput("\u001b");
        }
        browserCalls += 1;
        return promise;
      },
      editor(_title: string, prefill: string) {
        originalPrefill = prefill;
        return Promise.resolve(prefill.replace("attachment", "cleaned attachment"));
      },
      getEditorText: () => "",
      notify() {},
    },
  } as unknown as ExtensionContext;

  try {
    await stashCommand.handler("", context);
    expect(originalPrefill.length).toBeGreaterThan(1024 * 1024);
    const edited = readdirSync(join(agentDir, "prompt-stash"))
      .filter((file) => file.endsWith(".json"))
      .map((file) =>
        JSON.parse(readFileSync(join(agentDir, "prompt-stash", file), "utf8")) as {
          attachments?: Array<{ kind: string }>;
          locked?: boolean;
          text: string;
        },
      )
      .find((entry) => entry.text.startsWith("[Large pasted prompt") && entry.attachments?.length === 2);
    expect(edited).toBeDefined();
    expect(edited!.attachments!.map((attachment) => attachment.kind).sort()).toEqual([
      "body",
      "image",
    ]);
    expect(edited!.locked).toBeFalse();
  } finally {
    if (previousVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = previousVisual;
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
  }
});

test("rejects an edit that would exceed the attachment limit and keeps the saved entry", async () => {
  const fixture = writeStashFixture("attachment limit edit");
  const stored = JSON.parse(readFileSync(fixture.path, "utf8"));
  stored.attachments = Array.from({ length: 64 }, () => ({
    kind: "image", ref: `sha256:${"a".repeat(64)}`, byteLength: 1, mimeType: "image/png",
  }));
  const original = JSON.stringify(stored);
  writeFileSync(fixture.path, original, { mode: 0o600 });
  const previousVisual = process.env.VISUAL;
  const previousEditor = process.env.EDITOR;
  delete process.env.VISUAL;
  delete process.env.EDITOR;
  let calls = 0;
  const notices: string[] = [];
  const context = {
    cwd: agentDir, mode: "tui", sessionManager: TEST_SESSION_MANAGER,
    ui: {
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = browserComponent(factory, resolve);
        if (calls++ === 0) {
          component.handleInput("/");
          component.handleInput("attachment limit edit");
          component.handleInput("\t");
          component.handleInput("e");
        } else {
          component.handleInput("\u001b");
          component.handleInput("\u001b");
        }
        return promise;
      },
      editor: async () => "x".repeat(1024 * 1024 + 1),
      getEditorText: () => "",
      notify: (text: string) => notices.push(text),
    },
  } as unknown as ExtensionContext;
  try {
    await stashCommand.handler("", context);
    expect(notices.at(-1)).toContain("at most 64 attachments");
    expect(readFileSync(fixture.path, "utf8")).toBe(original);
    notices.length = 0;
    await stashCommand.handler("", context);
    expect(notices).toEqual([]);
  } finally {
    rmSync(fixture.path);
    if (previousVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = previousVisual;
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
  }
});

test("recovers complete crash temps and quarantines incomplete bytes without discarding them", async () => {
  const stashDir = join(agentDir, "prompt-stash");
  const crashId = randomUUID();
  const crashTime = new Date(Date.now() + 5_000).toISOString();
  const crashName = `.${crashId}.tmp`;
  const crashPath = join(stashDir, crashName);
  writeFileSync(
    crashPath,
    `${JSON.stringify({
      id: crashId,
      text: "crash-window prompt",
      inputMode: "normal",
      stashedAt: crashTime,
      origin: TEST_ORIGIN,
    })}\n`,
    { mode: 0o600 },
  );
  const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  utimesSync(crashPath, staleTime, staleTime);

  let editor = "cleanup trigger";
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      getEditorText: () => editor,
      setEditorText(value: string) {
        editor = value;
      },
      notify() {},
    },
  } as unknown as ExtensionContext;
  await stashShortcut.handler(context);

  expect(readdirSync(stashDir)).toContain(crashName);
  editor = "";
  await stashCommand.handler("restore", context);
  expect(editor).toBe("crash-window prompt");

  const invalidId = randomUUID();
  const invalidName = `.${invalidId}.tmp`;
  const invalidPath = join(stashDir, invalidName);
  const partial = "partial prompt bytes";
  writeFileSync(invalidPath, partial, { mode: 0o600 });
  utimesSync(invalidPath, staleTime, staleTime);
  editor = "second cleanup trigger";
  await stashShortcut.handler(context);

  expect(readdirSync(stashDir)).toContain(`${invalidName}.orphan`);
  expect(readFileSync(`${invalidPath}.orphan`, "utf8")).toBe(partial);
});
test("counts a cached stash once when its recovery file is also present", async () => {
  const sessionId = randomUUID();
  const fixture = writeStashFixture("cached recovery duplicate", { ...TEST_ORIGIN, sessionId });
  const recoveryPath = join(agentDir, "prompt-stash", `.${fixture.id}.tmp`);
  let requestDelete = false;
  let confirmation = "";
  const context = {
    cwd: agentDir, mode: "tui",
    sessionManager: { ...TEST_SESSION_MANAGER, getSessionId: () => sessionId },
    ui: {
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = browserComponent(factory, resolve);
        component.handleInput(requestDelete ? "D" : "\u001b");
        requestDelete = false;
        return promise;
      },
      confirm: async (_title: string, message: string) => {
        confirmation = message;
        return false;
      },
      getEditorText: () => "",
      notify() {},
    },
  } as unknown as ExtensionContext;
  try {
    await stashCommand.handler("", context);
    writeFileSync(recoveryPath, readFileSync(fixture.path), { mode: 0o600 });
    requestDelete = true;
    await stashCommand.handler("", context);
    expect(confirmation).toStartWith("Permanently delete 1 unlocked stashed prompt ");
  } finally {
    rmSync(fixture.path);
    rmSync(recoveryPath, { force: true });
  }
});

test("never deletes another writer's replacement temp after an edit collision", async () => {
  const previousVisual = process.env.VISUAL;
  const previousEditor = process.env.EDITOR;
  delete process.env.VISUAL;
  delete process.env.EDITOR;
  const stashDir = join(agentDir, "prompt-stash");
  const sourceFile = readdirSync(stashDir)
    .filter((file) => file.endsWith(".json"))
    .find((file) => readFileSync(join(stashDir, file), "utf8").includes("edited test prompt"));
  expect(sourceFile).toBeDefined();
  const sourceBytes = readFileSync(join(stashDir, sourceFile!));
  const persisted = JSON.parse(sourceBytes.toString("utf8")) as { id: string };
  const foreignTemp = join(stashDir, `.${persisted.id}.tmp`);
  writeFileSync(foreignTemp, sourceBytes, { mode: 0o600 });
  const notifications: string[] = [];
  let customCalls = 0;
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = factory(
          {
            terminal: { rows: 60, write: () => {} },
            requestRender() {},
            resetDisplay() {},
            stop() {},
            start() {},
          },
          TEST_THEME,
          undefined,
          resolve,
        );
        if (customCalls === 0) {
          component.handleInput("/");
          component.handleInput("edited test prompt");
          component.handleInput("\t");
          component.handleInput("e");
        } else {
          component.handleInput("\u001b");
          component.handleInput("\u001b");
        }
        customCalls += 1;
        return promise;
      },
      editor: async () => "foreign-temp conflict edit",
      getEditorText: () => "",
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;

  await stashCommand.handler("", context);

  expect(readFileSync(foreignTemp)).toEqual(sourceBytes);
  expect(notifications.at(-1)).toBe(
    "Stash changed concurrently; edited text was preserved as a new stash",
  );
  expect(
    readdirSync(stashDir)
      .filter((file) => file.endsWith(".json"))
      .some((file) => readFileSync(join(stashDir, file), "utf8").includes("foreign-temp conflict edit")),
  ).toBeTrue();
  rmSync(foreignTemp, { force: true });
  if (previousVisual === undefined) delete process.env.VISUAL;
  else process.env.VISUAL = previousVisual;
  if (previousEditor === undefined) delete process.env.EDITOR;
  else process.env.EDITOR = previousEditor;
});

test("preserves both results when concurrent editors start from one stash revision", async () => {
  const previousVisual = process.env.VISUAL;
  const previousEditor = process.env.EDITOR;
  delete process.env.VISUAL;
  delete process.env.EDITOR;
  const { promise: bothEditorsReady, resolve: releaseEditors } = Promise.withResolvers<void>();
  let readyEditors = 0;
  const runEdit = async (editedText: string) => {
    let browserCalls = 0;
    const context = {
      cwd: agentDir,
      mode: "tui",
      sessionManager: TEST_SESSION_MANAGER,
      ui: {
        custom(factory: Function) {
          const { promise, resolve } = Promise.withResolvers<unknown>();
          const component = factory(
            {
              terminal: { rows: 60, write: () => {} },
              requestRender() {},
              resetDisplay() {},
              stop() {},
              start() {},
            },
            TEST_THEME,
            undefined,
            resolve,
          );
          if (browserCalls === 0) {
            component.handleInput("/");
            component.handleInput("edited test prompt");
            component.handleInput("\t");
            component.handleInput("e");
          } else {
            component.handleInput("\u001b");
            component.handleInput("\u001b");
          }
          browserCalls += 1;
          return promise;
        },
        async editor() {
          readyEditors += 1;
          if (readyEditors === 2) releaseEditors();
          await bothEditorsReady;
          return editedText;
        },
        getEditorText: () => "",
        notify() {},
      },
    } as unknown as ExtensionContext;
    await stashCommand.handler("", context);
  };

  try {
    await Promise.all([
      runEdit("concurrent edit A"),
      runEdit("concurrent edit B"),
    ]);
    const persistedText = readdirSync(join(agentDir, "prompt-stash"))
      .filter((file) => file.endsWith(".json"))
      .map((file) => readFileSync(join(agentDir, "prompt-stash", file), "utf8"));
    expect(persistedText.some((text) => text.includes("concurrent edit A"))).toBeTrue();
    expect(persistedText.some((text) => text.includes("concurrent edit B"))).toBeTrue();
    const concurrentEntries = persistedText
      .filter((text) => text.includes("concurrent edit A") || text.includes("concurrent edit B"))
      .map((text) => JSON.parse(text));
    expect(concurrentEntries).toHaveLength(2);
    expect(
      concurrentEntries.every((entry) => entry.origin?.sessionId === TEST_SESSION_ID),
    ).toBeTrue();
  } finally {
    if (previousVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = previousVisual;
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
  }
});

test.each(["e", "l"])("keeps a newly published stash when applying %s to an older recovery file", async (action) => {
  const sessionId = randomUUID();
  const fixture = writeStashFixture("recovery publication race", { ...TEST_ORIGIN, sessionId });
  const original = JSON.parse(readFileSync(fixture.path, "utf8"));
  const recoveryPath = join(agentDir, "prompt-stash", `.${fixture.id}.tmp`);
  writeFileSync(recoveryPath, JSON.stringify(original), { mode: 0o600 });
  rmSync(fixture.path);
  const previousVisual = process.env.VISUAL;
  const previousEditor = process.env.EDITOR;
  delete process.env.VISUAL;
  delete process.env.EDITOR;
  let calls = 0;
  const context = {
    cwd: agentDir, mode: "tui",
    sessionManager: { ...TEST_SESSION_MANAGER, getSessionId: () => sessionId },
    ui: {
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = browserComponent(factory, resolve);
        if (calls === 0 && action === "l") {
          writeFileSync(fixture.path, JSON.stringify({ ...original, text: "newly published", locked: true }), { mode: 0o600 });
        }
        component.handleInput(calls++ === 0 ? action : "\u001b");
        return promise;
      },
      editor: async () => {
        writeFileSync(fixture.path, JSON.stringify({ ...original, text: "newly published", locked: true }), { mode: 0o600 });
        return "edited recovery";
      },
      getEditorText: () => "",
      notify() {},
    },
  } as unknown as ExtensionContext;
  try {
    await stashCommand.handler("", context);
    const published = JSON.parse(readFileSync(fixture.path, "utf8"));
    expect(published.text).toBe("newly published");
    expect(published.locked).toBeTrue();
    const saved = readdirSync(join(agentDir, "prompt-stash"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(agentDir, "prompt-stash", name), "utf8")));
    expect(saved.some((entry) => entry.origin?.sessionId === sessionId && entry.text === "edited recovery")).toBe(action === "e");
  } finally {
    rmSync(recoveryPath, { force: true });
    for (const name of readdirSync(join(agentDir, "prompt-stash"))) {
      if (!name.endsWith(".json")) continue;
      const path = join(agentDir, "prompt-stash", name);
      if (JSON.parse(readFileSync(path, "utf8")).origin?.sessionId === sessionId) rmSync(path);
    }
    if (previousVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = previousVisual;
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
  }
});

test("preserves concurrent edits that begin from one recoverable temp", async () => {
  const previousVisual = process.env.VISUAL;
  const previousEditor = process.env.EDITOR;
  delete process.env.VISUAL;
  delete process.env.EDITOR;
  const stashDir = join(agentDir, "prompt-stash");
  const id = randomUUID();
  const stashedAt = new Date(Date.now() + 20_000).toISOString();
  writeFileSync(
    join(stashDir, `.${id}.tmp`),
    `${JSON.stringify({
      id,
      text: "recovery concurrent base",
      inputMode: "normal",
      stashedAt,
      origin: TEST_ORIGIN,
      attachments: [],
      locked: false,
    })}\n`,
    { mode: 0o600 },
  );
  const { promise: bothEditorsReady, resolve: releaseEditors } = Promise.withResolvers<void>();
  let readyEditors = 0;
  const runEdit = async (editedText: string) => {
    let browserCalls = 0;
    const context = {
      cwd: agentDir,
      mode: "tui",
      sessionManager: TEST_SESSION_MANAGER,
      ui: {
        custom(factory: Function) {
          const { promise, resolve } = Promise.withResolvers<unknown>();
          const component = factory(
            {
              terminal: { rows: 60, write: () => {} },
              requestRender() {},
              resetDisplay() {},
              stop() {},
              start() {},
            },
            TEST_THEME,
            undefined,
            resolve,
          );
          if (browserCalls === 0) {
            component.handleInput("/");
            component.handleInput("recovery concurrent base");
            component.handleInput("\t");
            component.handleInput("e");
          } else {
            component.handleInput("\u001b");
            component.handleInput("\u001b");
          }
          browserCalls += 1;
          return promise;
        },
        async editor() {
          readyEditors += 1;
          if (readyEditors === 2) releaseEditors();
          await bothEditorsReady;
          return editedText;
        },
        getEditorText: () => "",
        notify() {},
      },
    } as unknown as ExtensionContext;
    await stashCommand.handler("", context);
  };

  try {
    await Promise.all([
      runEdit("recovery concurrent edit A"),
      runEdit("recovery concurrent edit B"),
    ]);
    const persistedText = readdirSync(stashDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readFileSync(join(stashDir, file), "utf8"));
    expect(persistedText.some((text) => text.includes("recovery concurrent edit A"))).toBeTrue();
    expect(persistedText.some((text) => text.includes("recovery concurrent edit B"))).toBeTrue();
  } finally {
    for (const file of readdirSync(stashDir)) {
      const path = join(stashDir, file);
      if (
        (file.endsWith(".json") && readFileSync(path, "utf8").includes("recovery concurrent")) ||
        file === `.${id}.tmp`
      ) {
        rmSync(path, { force: true });
      }
    }
    if (previousVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = previousVisual;
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
  }
});

test("defaults to this chat and exposes labeled global stashes without losing search state", async () => {
  const otherSessionId = randomUUID();
  const otherOrigin = {
    sessionId: otherSessionId,
    sessionName: "Other Chat",
    sessionStartedAt: "2026-07-27T10:00:00.000Z",
    workspaceName: "other-workspace",
  };
  const fixtures = [
    writeStashFixture("current scope prompt"),
    writeStashFixture("other scope prompt", otherOrigin),
    writeStashFixture("legacy scope prompt", null),
    writeStashFixture("malformed origin prompt", { sessionId: 42 }),
  ];
  let currentFrame = "";
  let allFrame = "";
  let globalSearchFrame = "";
  let currentSearchFrame = "";
  let legacyFrame = "";
  let malformedFrame = "";
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = browserComponent(factory, resolve, { rows: 60, write: () => {} });
        currentFrame = component.render(120).join("\n");
        component.handleInput("g");
        allFrame = component.render(120).join("\n");
        component.handleInput("/");
        for (const character of "other-workspace") component.handleInput(character);
        globalSearchFrame = component.render(120).join("\n");
        component.handleInput("\t");
        component.handleInput("g");
        currentSearchFrame = component.render(120).join("\n");
        component.handleInput("g");
        component.handleInput("\u001b");
        component.handleInput("/");
        for (const character of "legacy scope prompt") component.handleInput(character);
        component.handleInput("\t");
        legacyFrame = component.render(120).join("\n");
        component.handleInput("\u001b");
        component.handleInput("/");
        for (const character of "malformed origin prompt") component.handleInput(character);
        component.handleInput("\t");
        malformedFrame = component.render(120).join("\n");
        component.handleInput("\u001b");
        component.handleInput("\u001b");
        return promise;
      },
      getEditorText: () => "",
      notify() {},
    },
  } as unknown as ExtensionContext;

  try {
    await stashCommand.handler("", context);
    const currentTitle = currentFrame.split("\n")[0] ?? "";
    expect(currentTitle).toContain("OhMyStash");
    expect(currentTitle).not.toContain("This chat");
    expect(currentFrame).toContain("This chat ·");
    expect(currentFrame).not.toContain("Press / to search");
    expect(currentFrame).toContain("current scope prompt");
    expect(currentFrame).not.toContain("other scope prompt");
    expect(currentFrame).not.toContain("legacy scope prompt");
    expect(allFrame).toContain("All chats ·");
    expect(allFrame).not.toContain("Press / to search");
    expect(allFrame).toContain("other scope");
    expect(allFrame).toContain("Other Chat");
    expect(allFrame).toContain("legacy scope");
    const allLines = allFrame.split("\n");
    const promptFooterIndex = allLines.findIndex(
      (line) => line.includes("Enter") && line.includes("Restore") && line.includes("e") && line.includes("Edit"),
    );
    const browserFooterIndex = allLines.findIndex(
      (line) => line.includes("/") && line.includes("Search") && line.includes("g") && line.includes("Current"),
    );
    expect(promptFooterIndex).toBeGreaterThan(0);
    expect(browserFooterIndex).toBeGreaterThan(promptFooterIndex);
    expect(allLines[browserFooterIndex]).not.toContain("Restore");
    expect(globalSearchFrame).toContain("other scope prompt");
    expect(globalSearchFrame).toContain("/other-workspace");
    expect(currentSearchFrame).toContain("/other-workspace");
    expect(currentSearchFrame).toContain("No prompts match this search");
    expect(legacyFrame).toContain("Chat: Before chat tracking");
    expect(malformedFrame).toContain("malformed origin prompt");
    expect(malformedFrame).toContain("Chat: Before chat tracking");
  } finally {
    for (const fixture of fixtures) rmSync(fixture.path, { force: true });
  }
});

test("restores the newest stash from the current chat instead of a newer global stash", async () => {
  const current = writeStashFixture("current restore winner");
  const other = writeStashFixture("newer global restore loser", {
    sessionId: randomUUID(),
    sessionName: "Newer Other Chat",
    workspaceName: "other-workspace",
  });
  let editor = "";
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      getEditorText: () => "",
      setEditorText(value: string) {
        editor = value;
      },
      notify() {},
    },
  } as unknown as ExtensionContext;

  try {
    await stashCommand.handler("restore", context);
    expect(editor).toBe("current restore winner");
  } finally {
    rmSync(current.path, { force: true });
    rmSync(other.path, { force: true });
  }
});

test("never restores another chat when the current chat has no stashes", async () => {
  const emptySessionId = randomUUID();
  let editor = "";
  const notifications: string[] = [];
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: {
      getSessionId: () => emptySessionId,
      getSessionName: () => "Empty Chat",
      getHeader: () => ({
        type: "session" as const,
        id: emptySessionId,
        timestamp: "2026-07-30T08:00:00.000Z",
        cwd: agentDir,
      }),
    },
    ui: {
      getEditorText: () => "",
      setEditorText(value: string) {
        editor = value;
      },
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;

  await stashShortcut.handler(context);

  expect(editor).toBe("");
  expect(notifications.at(-1)).toContain("No stashed prompts in this chat");
  expect(notifications.at(-1)).toContain("available in other chats");
});

test("keeps an empty current scope open and bulk-deletes only that scope", async () => {
  const isolatedSessionId = randomUUID();
  const isolatedManager = {
    getSessionId: () => isolatedSessionId,
    getSessionName: () => "Isolated Chat",
    getHeader: () => ({
      type: "session" as const,
      id: isolatedSessionId,
      timestamp: "2026-07-29T08:00:00.000Z",
      cwd: agentDir,
    }),
  };
  const isolatedOrigin = {
    sessionId: isolatedSessionId,
    sessionName: "Isolated Chat",
    sessionStartedAt: "2026-07-29T08:00:00.000Z",
    workspaceName: "isolated-workspace",
  };
  const first = writeStashFixture("isolated delete one", isolatedOrigin);
  const second = writeStashFixture("isolated delete two", isolatedOrigin);
  const other = writeStashFixture("global survivor", {
    sessionId: randomUUID(),
    sessionName: "Survivor Chat",
    workspaceName: "survivor-workspace",
  });
  const confirmTitles: string[] = [];
  let browserCalls = 0;
  let emptyFrame = "";
  let globalFrame = "";
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: isolatedManager,
    ui: {
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = browserComponent(factory, resolve, { rows: 60, write: () => {} });
        if (browserCalls === 0) {
          component.handleInput("D");
        } else {
          emptyFrame = component.render(120).join("\n");
          component.handleInput("g");
          globalFrame = component.render(120).join("\n");
          component.handleInput("\u001b");
        }
        browserCalls += 1;
        return promise;
      },
      confirm(title: string) {
        confirmTitles.push(title);
        return Promise.resolve(true);
      },
      getEditorText: () => "",
      notify() {},
    },
  } as unknown as ExtensionContext;

  try {
    await stashCommand.handler("", context);
    expect(confirmTitles).toEqual(["Delete unlocked stashes from this chat?"]);
    expect(existsSync(first.path)).toBeFalse();
    expect(existsSync(second.path)).toBeFalse();
    expect(existsSync(other.path)).toBeTrue();
    expect(emptyFrame).toContain("No stashes in this chat");
    expect(emptyFrame).toContain("Press g to view all chats");
    expect(globalFrame).toContain("global survivor");
    expect(globalFrame).toContain("Survivor Chat");
  } finally {
    rmSync(first.path, { force: true });
    rmSync(second.path, { force: true });
    rmSync(other.path, { force: true });
  }
});

test("refuses to delete a stash changed after the browser loaded", async () => {
  const fixture = writeStashFixture("stale deletion target");
  const notifications: string[] = [];
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = browserComponent(factory, resolve, { rows: 60, write: () => {} });
        component.handleInput("/");
        for (const character of "stale deletion target") component.handleInput(character);
        component.handleInput("\t");
        component.handleInput("d");
        return promise;
      },
      confirm() {
        const payload = JSON.parse(readFileSync(fixture.path, "utf8"));
        payload.text = "concurrent replacement";
        writeFileSync(fixture.path, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
        return Promise.resolve(true);
      },
      getEditorText: () => "",
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;

  try {
    await stashCommand.handler("", context);
    expect(existsSync(fixture.path)).toBeTrue();
    expect(readFileSync(fixture.path, "utf8")).toContain("concurrent replacement");
    expect(notifications.at(-1)).toContain("Stash changed after the browser loaded");
  } finally {
    rmSync(fixture.path, { force: true });
  }
});

test("expires only old unlocked normal stashes", async () => {
  const stashDir = join(agentDir, "prompt-stash");
  const expiredAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const ageFixture = (
    fixture: ReturnType<typeof writeStashFixture>,
    patch: Record<string, unknown> = {},
    preserved = false,
  ) => {
    const payload = JSON.parse(readFileSync(fixture.path, "utf8"));
    Object.assign(payload, { stashedAt: expiredAt }, patch);
    const path = preserved ? fixture.path.replace(/\.json$/, ".preserved.json") : fixture.path;
    writeFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    if (path !== fixture.path) rmSync(fixture.path, { force: true });
    return path;
  };

  const expired = ageFixture(writeStashFixture("expired normal stash"));
  const locked = ageFixture(writeStashFixture("expired locked stash"), { locked: true });
  const preserved = ageFixture(
    writeStashFixture("expired conflict copy"),
    { preserved: true },
    true,
  );
  const fresh = writeStashFixture("fresh retained stash");
  const recoveryId = randomUUID();
  const recovery = join(stashDir, `.${recoveryId}.tmp`);
  writeFileSync(
    recovery,
    `${JSON.stringify({
      id: recoveryId,
      text: "expired recovery stash",
      inputMode: "normal",
      stashedAt: expiredAt,
      origin: TEST_ORIGIN,
      attachments: [],
      locked: false,
      preserved: true,
    })}\n`,
    { mode: 0o600 },
  );

  try {
    writeSettings({
      "Dim background": true,
      "Time format": "12-hour clock",
      "Retention days": 1,
    });
    await refreshConfig?.({}, { cwd: agentDir } as ExtensionContext);

    expect(existsSync(expired)).toBeFalse();
    expect(existsSync(locked)).toBeTrue();
    expect(existsSync(preserved)).toBeTrue();
    expect(existsSync(recovery)).toBeTrue();
    expect(existsSync(fresh.path)).toBeTrue();

    const indefinite = ageFixture(writeStashFixture("indefinite retained stash"));
    writeSettings({
      "Dim background": true,
      "Time format": "12-hour clock",
      "Retention days": 0,
    });
    await refreshConfig?.({}, { cwd: agentDir } as ExtensionContext);
    expect(existsSync(indefinite)).toBeTrue();
    rmSync(indefinite, { force: true });
  } finally {
    writeSettings({ "Dim background": true, "Time format": "12-hour clock" });
    await refreshConfig?.({}, { cwd: agentDir } as ExtensionContext);
    for (const path of [expired, locked, preserved, recovery, fresh.path]) {
      rmSync(path, { force: true });
    }
  }
});

test("locks stashes against selected and delete-all actions", async () => {
  const stashDir = join(agentDir, "prompt-stash");
  const countEntries = () => {
    const files = readdirSync(stashDir);
    return files.filter(
      (file) =>
        file.endsWith(".json") ||
        /^\.[0-9a-f-]{36}\.tmp$/i.test(file),
    ).length;
  };
  const runAction = async (key: "d" | "D" | "l", confirmed: boolean, search?: string) => {
    let customCalls = 0;
    let reopenedFrame = "";
    const confirmTitles: string[] = [];
    const notifications: string[] = [];
    const initialIndexes: Array<number | undefined> = [];
    const terminal = { rows: 100, write: () => {} };
    const context = {
      cwd: agentDir,
      mode: "tui",
      sessionManager: TEST_SESSION_MANAGER,
      ui: {
        custom(factory: Function) {
          const { promise, resolve } = Promise.withResolvers<unknown>();
          const component = browserComponent(factory, resolve, terminal);
          if (customCalls === 0) {
            if (search) {
              component.handleInput("/");
              component.handleInput(search);
              component.handleInput("\t");
            }
            component.handleInput(key);
          } else {
            reopenedFrame = component.render(120).join("\n");
            component.handleInput("\u001b");
            if (search) component.handleInput("\u001b");
          }
          customCalls += 1;
          return promise;
        },
        confirm(
          title: string,
          _message: string,
          options?: { initialIndex?: number },
        ) {
          confirmTitles.push(title);
          initialIndexes.push(options?.initialIndex);
          return Promise.resolve(confirmed);
        },
        notify(message: string) {
          notifications.push(message);
        },
      },
    } as unknown as ExtensionContext;

    await stashCommand.handler("", context);
    return { confirmTitles, initialIndexes, notifications, reopenedFrame };
  };

  let sentinelEditor = "lock-protection-sentinel";
  await stashShortcut.handler({
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      getEditorText: () => sentinelEditor,
      setEditorText(value: string) {
        sentinelEditor = value;
      },
      notify() {},
    },
  } as unknown as ExtensionContext);

  expect(countEntries()).toBe(11);
  const locked = await runAction("l", false, "lock-protection-sentinel");
  expect(locked.confirmTitles).toEqual([]);
  expect(locked.notifications).toContain("Stash locked");
  expect(countEntries()).toBe(11);

  const blockedDelete = await runAction("d", true, "lock-protection-sentinel");
  expect(blockedDelete.confirmTitles).toEqual([]);
  expect(blockedDelete.notifications).toContain("Unlock this stash before deleting it");
  expect(countEntries()).toBe(11);

  const cancelledSelected = await runAction("d", false, "concurrent edit");
  expect(cancelledSelected.confirmTitles).toEqual(["Delete stashed prompt?"]);
  expect(cancelledSelected.initialIndexes).toEqual([1]);
  expect(countEntries()).toBe(11);

  await runAction("d", true, "concurrent edit");
  expect(countEntries()).toBe(10);

  const cancelledAll = await runAction("D", false);
  expect(cancelledAll.confirmTitles).toEqual(["Delete unlocked stashes from this chat?"]);
  expect(cancelledAll.initialIndexes).toEqual([1]);
  expect(countEntries()).toBe(10);

  await runAction("D", true);
  expect(countEntries()).toBe(1);

  await runAction("l", false);
  await runAction("D", true);
  expect(countEntries()).toBe(0);
});

test("keeps quota-preserved conflict copies visible in the browser", async () => {
  const previousVisual = process.env.VISUAL;
  const previousEditor = process.env.EDITOR;
  delete process.env.VISUAL;
  delete process.env.EDITOR;
  const stashDir = join(agentDir, "prompt-stash");
  let editorText = "";
  const saveContext = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      getEditorText: () => editorText,
      setEditorText(value: string) {
        editorText = value;
      },
      notify() {},
    },
  } as unknown as ExtensionContext;
  for (let index = 0; index < 256; index += 1) {
    editorText = `quota visibility prompt ${index}`;
    await stashShortcut.handler(saveContext);
  }

  let browserCalls = 0;
  let reopenedFrame = "";
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = factory(
          {
            terminal: { rows: 60, write: () => {} },
            requestRender() {},
            resetDisplay() {},
            stop() {},
            start() {},
          },
          TEST_THEME,
          undefined,
          resolve,
        );
        if (browserCalls === 0) {
          component.handleInput("e");
        } else {
          reopenedFrame = component.render(120).join("\n");
          component.handleInput("\u001b");
        }
        browserCalls += 1;
        return promise;
      },
      editor(_title: string, prefill: string) {
        const target = readdirSync(stashDir)
          .filter((file) => file.endsWith(".json"))
          .find((file) => JSON.parse(readFileSync(join(stashDir, file), "utf8")).text === prefill);
        expect(target).toBeDefined();
        const current = JSON.parse(readFileSync(join(stashDir, target!), "utf8"));
        current.text = "quota concurrent winner";
        writeFileSync(join(stashDir, target!), `${JSON.stringify(current, null, 2)}\n`, {
          mode: 0o600,
        });
        return Promise.resolve("quota preserved editor result");
      },
      getEditorText: () => "",
      notify() {},
    },
  } as unknown as ExtensionContext;

  try {
    writeSettings({
      "Dim background": true,
      "Time format": "12-hour clock",
      "Editor command": "",
    });
    await refreshConfig?.({}, { cwd: agentDir } as ExtensionContext);
    await stashCommand.handler("", context);

    const files = readdirSync(stashDir).filter((file) => file.endsWith(".json"));
    expect(files).toHaveLength(257);
    expect(reopenedFrame).toContain("This chat · 1 of 257");
    const texts = files.map((file) => JSON.parse(readFileSync(join(stashDir, file), "utf8")).text);
    expect(texts).toContain("quota concurrent winner");
    expect(texts).toContain("quota preserved editor result");
  } finally {
    if (previousVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = previousVisual;
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
    writeSettings({ "Dim background": true, "Time format": "12-hour clock" });
    await refreshConfig?.({}, { cwd: agentDir } as ExtensionContext);
  }
});

test("keeps preserved crash-recovery temps visible beyond the normal quota", async () => {
  const stashDir = join(agentDir, "prompt-stash");
  const id = randomUUID();
  const stashedAt = new Date(Date.now() + 10_000).toISOString();
  writeFileSync(
    join(stashDir, `.${id}.tmp`),
    `${JSON.stringify({
      id,
      text: "preserved crash-window conflict",
      inputMode: "normal",
      stashedAt,
      origin: TEST_ORIGIN,
      attachments: [],
      locked: false,
      preserved: true,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  let frame = "";
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = browserComponent(factory, resolve, { rows: 60, write: () => {} });
        frame = component.render(120).join("\n");
        component.handleInput("\u001b");
        return promise;
      },
      getEditorText: () => "",
      notify() {},
    },
  } as unknown as ExtensionContext;

  await stashCommand.handler("", context);

  expect(
    readdirSync(stashDir).filter(
      (file) => file.endsWith(".json") || /^\.[0-9a-f-]{36}\.tmp$/i.test(file),
    ),
  ).toHaveLength(258);
  expect(frame).toContain("This chat · 1 of 258");
  expect(frame).toContain("preserved crash-window conflict");
});

test("keeps every recoverable temp visible beyond the recovery-window size", async () => {
  const stashDir = join(agentDir, "prompt-stash");
  const initialEntries = readdirSync(stashDir).filter(
    (file) => file.endsWith(".json") || /^\.[0-9a-f-]{36}\.tmp$/i.test(file),
  ).length;
  for (let index = 0; index < 257; index += 1) {
    const id = randomUUID();
    const stashedAt = new Date(Date.now() + 20_000 + index).toISOString();
    writeFileSync(
      join(stashDir, `.${id}.tmp`),
      `${JSON.stringify({
        id,
        text: `overflow recovery ${index} ${"x".repeat(70_000)}`,
        inputMode: "normal",
        stashedAt,
        origin: TEST_ORIGIN,
        attachments: [],
        locked: false,
        preserved: true,
      })}\n`,
      { mode: 0o600 },
    );
  }
  let frame = "";
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: TEST_SESSION_MANAGER,
    ui: {
      custom(factory: Function) {
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const component = browserComponent(factory, resolve, { rows: 60, write: () => {} });
        frame = component.render(120).join("\n");
        component.handleInput("\u001b");
        return promise;
      },
      getEditorText: () => "",
      notify() {},
    },
  } as unknown as ExtensionContext;

  await stashCommand.handler("", context);

  const expectedEntries = initialEntries + 257;
  expect(
    readdirSync(stashDir).filter(
      (file) => file.endsWith(".json") || /^\.[0-9a-f-]{36}\.tmp$/i.test(file),
    ),
  ).toHaveLength(expectedEntries);
  expect(frame).toContain(`This chat · 1 of ${expectedEntries}`);
  expect(frame).toContain("overflow recovery 256");
});
