import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type * as Tui from "@oh-my-pi/pi-tui";

type BrowserComponent = { handleInput(data: string): void; render(width: number): string[] };
type BrowserFactory = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: (value: unknown) => void,
) => BrowserComponent;

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousConfigDir = process.env.PI_CONFIG_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "oms-browser-ui-test-"));
const stashDir = join(agentDir, "prompt-stash");
const TEST_THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
let visibleWidth: typeof Tui.visibleWidth;
let refreshDirsFromEnv: () => void;
let stashCommand: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void };
let refreshConfig: (event: unknown, ctx: ExtensionContext) => Promise<void>;
let fixtureCount = 0;

function writeStash(text: string, sessionId: string): string {
  const id = randomUUID();
  fixtureCount += 1;
  const stashedAt = new Date(Date.now() - fixtureCount * 1000).toISOString();
  const path = join(stashDir, `${stashedAt.replaceAll(":", "-")}-${id}.json`);
  const origin = { sessionId, sessionName: "Browser Tests", workspaceName: "browser-ui" };
  writeFileSync(
    path,
    `${JSON.stringify({ id, text, inputMode: "normal", stashedAt, origin, attachments: [], locked: false, preserved: false })}\n`,
    { mode: 0o600 },
  );
  return path;
}

async function useLayout(layout: string): Promise<void> {
  mkdirSync(join(agentDir, ".omp"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(agentDir, ".omp", "plugin-overrides.json"),
    JSON.stringify({ settings: { "@hkay-dev/ohmystash": { "Browser layout": layout } } }),
    { mode: 0o600 },
  );
  await refreshConfig({}, { cwd: agentDir } as ExtensionContext);
}

async function openBrowser(sessionId: string): Promise<BrowserFactory> {
  let factory: BrowserFactory | undefined;
  const notices: string[] = [];
  const context = {
    cwd: agentDir,
    mode: "tui",
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      custom(next: BrowserFactory) {
        factory = next;
        return Promise.resolve(null);
      },
      notify(message: string) {
        notices.push(message);
      },
      getEditorText: () => "",
    },
  } as unknown as ExtensionContext;
  await stashCommand.handler("", context);
  if (!factory) throw new Error(`The browser was not presented: ${notices.join("; ")}`);
  return factory;
}

function browser(factory: BrowserFactory, rows: number): BrowserComponent {
  return factory({ terminal: { rows }, requestRender() {} }, TEST_THEME, undefined, () => {});
}

beforeAll(async () => {
  // SDK modules capture the agent dir when they first load, so import them only after pointing it
  // at the temp dir. Bun shares modules across test files, so rebind it in case one loaded first.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // getPluginSettings also merges <config root>/plugins/omp-plugins.lock.json, and the config root is
  // os.homedir() joined with PI_CONFIG_DIR. Bun reads HOME only at startup, so point PI_CONFIG_DIR here.
  process.env.PI_CONFIG_DIR = relative(homedir(), agentDir);
  ({ refreshDirsFromEnv } = await import("@oh-my-pi/pi-utils"));
  refreshDirsFromEnv();
  ({ visibleWidth } = await import("@oh-my-pi/pi-tui"));
  mkdirSync(stashDir, { mode: 0o700 });
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
});

afterAll(async () => {
  await useLayout("Automatic");
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

test("fits every browser layout, its title, and its search row in OMP's bottom overlay", async () => {
  const chat = randomUUID();
  const paths = [
    writeStash("kiwi lemon\nsecond line", chat),
    writeStash("kiwi mango tango\nmore lines here", chat),
    writeStash("plain papaya", chat),
    writeStash("kiwi from another chat", randomUUID()),
    writeStash("banana elsewhere", randomUUID()),
  ];
  try {
    const failures: string[] = [];
    for (const layout of ["Automatic", "Side by side", "Stacked", "Compact"]) {
      await useLayout(layout);
      const factory = await openBrowser(chat);
      for (let rows = 1; rows <= 20; rows += 1) {
        for (const width of [10, 40, 72, 80, 100, 120]) {
          for (const scopeKeys of [[], ["g"]]) {
            for (const query of ["kiwi", "zzxz"]) {
              const component = browser(factory, rows);
              for (const key of [...scopeKeys, "/", ...query, "\t"]) component.handleInput(key);
              const lines = component.render(width);
              const label = `${layout} ${width}x${rows} ${scopeKeys.length > 0 ? "all chats" : "this chat"} /${query}`;
              // The overlay gets every terminal row; OMP drops taller output from the top, title first.
              if (lines.length > rows) failures.push(`${label}: ${lines.length} rows for ${rows}`);
              if (lines.some((line) => visibleWidth(line) > width)) failures.push(`${label}: wider than ${width}`);
              if (!lines[0]) failures.push(`${label}: no title row`);
              if (rows >= 2 && lines.findIndex((line) => line.includes(`/${query}`)) !== 1) {
                failures.push(`${label}: search row is not directly below the title`);
              }
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  } finally {
    for (const path of paths) rmSync(path, { force: true });
  }
});

test("clips compact empty-chat notices to narrow terminals", async () => {
  const path = writeStash("kiwi from another chat", randomUUID());
  try {
    await useLayout("Compact");
    const factory = await openBrowser(randomUUID());
    for (const width of [1, 10, 16]) {
      for (const line of browser(factory, 12).render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  } finally {
    rmSync(path, { force: true });
  }
});

test("keeps typo search keystrokes off the full text of long stashes", async () => {
  const chat = randomUUID();
  const body = "lemon mango papaya ".repeat(12_000);
  const paths = [1, 2, 3, 4].map((index) => writeStash(`${index} ${body}`, chat));
  const toLowerCase = String.prototype.toLowerCase;
  try {
    await useLayout("Compact");
    const component = browser(await openBrowser(chat), 24);
    component.handleInput("/");
    // No stash contains "z", so every keystroke falls back to fuzzy search.
    component.handleInput("z");
    let lowered = 0;
    String.prototype.toLowerCase = function (this: string) {
      lowered += this.length;
      return toLowerCase.call(this);
    };
    for (const key of "xzx") component.handleInput(key);
    String.prototype.toLowerCase = toLowerCase;
    expect(lowered).toBeLessThan(body.length);
  } finally {
    String.prototype.toLowerCase = toLowerCase;
    for (const path of paths) rmSync(path, { force: true });
  }
});

test("reuses the selected preview while search keystrokes keep the same stash selected", async () => {
  const chat = randomUUID();
  const path = writeStash(`kiwi ${"crème brûlée ".repeat(4_000)}`, chat);
  const segment = Intl.Segmenter.prototype.segment;
  try {
    await useLayout("Stacked");
    const component = browser(await openBrowser(chat), 40);
    component.render(100);
    let previewBuilds = 0;
    Intl.Segmenter.prototype.segment = function (this: Intl.Segmenter, input: string) {
      if (input.length > 1_000) previewBuilds += 1;
      return segment.call(this, input);
    };
    component.handleInput("/");
    for (const key of "kiwi") {
      component.handleInput(key);
      component.render(100);
    }
    Intl.Segmenter.prototype.segment = segment;
    expect(previewBuilds).toBe(0);
  } finally {
    Intl.Segmenter.prototype.segment = segment;
    rmSync(path, { force: true });
  }
});
