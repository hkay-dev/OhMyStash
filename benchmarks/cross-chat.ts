import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const caseSize = Number.parseInt(process.argv[2] ?? "", 10);

if (!Number.isFinite(caseSize)) {
  const rows: Array<Record<string, number>> = [];
  for (const count of [50, 256]) {
    const child = Bun.spawnSync({
      cmd: [process.execPath, fileURLToPath(import.meta.url), String(count)],
      stdout: "pipe",
      stderr: "inherit",
    });
    if (child.exitCode !== 0) process.exit(child.exitCode);
    rows.push(JSON.parse(child.stdout.toString()) as Record<string, number>);
  }

  console.log("\nCross-chat OhMyStash medians (ms)");
  console.table(rows);
  process.exit(0);
}

const agentDir = mkdtempSync(join(tmpdir(), `prompt-stash-benchmark-${caseSize}-`));
process.env.PI_CODING_AGENT_DIR = agentDir;

const stashDir = join(agentDir, "prompt-stash");
mkdirSync(stashDir, { recursive: true, mode: 0o700 });
const chatCount = caseSize === 50 ? 10 : 16;
const sessionIds = Array.from({ length: chatCount }, () => randomUUID());
const startedAt = "2026-07-28T12:00:00.000Z";

for (let index = 0; index < caseSize; index += 1) {
  const id = randomUUID();
  const stashedAt = new Date(Date.UTC(2026, 6, 28, 12, 0, 0, index)).toISOString();
  const chatIndex = index % chatCount;
  const text = `fixture ${index} from chat ${chatIndex}\n${"representative prompt text ".repeat(index % 9)}`;
  const payload = {
    id,
    text,
    inputMode: index % 7 === 0 ? "queue" : "normal",
    stashedAt,
    origin: {
      sessionId: sessionIds[chatIndex],
      sessionName: chatIndex % 5 === 0 ? "Duplicate Chat" : `Benchmark Chat ${chatIndex}`,
      sessionStartedAt: startedAt,
      workspaceName: `workspace-${chatIndex % 4}`,
    },
    attachments: [],
    locked: index % 13 === 0,
    preserved: false,
  };
  writeFileSync(
    join(stashDir, `${stashedAt.replaceAll(":", "-")}-${id}.json`),
    `${JSON.stringify(payload)}\n`,
    { mode: 0o600 },
  );
}

const projectConfigDir = join(agentDir, ".omp");
mkdirSync(projectConfigDir, { recursive: true, mode: 0o700 });
const writeLayout = (layout: string) =>
  writeFileSync(
    join(projectConfigDir, "plugin-overrides.json"),
    JSON.stringify({
      settings: {
        "@hkay-dev/ohmystash": {
          "Browser layout": layout,
          "Dim background": true,
          "Maximum body rows": 36,
        },
      },
    }),
    { mode: 0o600 },
  );

writeLayout("Automatic");
// The child sets PI_CODING_AGENT_DIR before loading the plugin so benchmarks cannot touch real stashes.
const { default: promptStash } = await import("../extensions/prompt-stash.ts");
let stashCommand!: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void };
let refreshConfig: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
const api = {
  on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) {
    if (event === "session_start") refreshConfig = handler;
  },
  registerShortcut() {},
  registerCommand(name: string, command: typeof stashCommand) {
    if (name === "stash") stashCommand = command;
  },
  sendUserMessage() {},
} as unknown as ExtensionAPI;
await promptStash(api);

const theme = {
  isLight: false,
  getFgAnsi: () => "\u001b[38;2;200;200;200m",
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  symbol: (name: string) => name,
};
const sessionManager = {
  getSessionId: () => sessionIds[0],
  getSessionName: () => "Duplicate Chat",
  getHeader: () => ({
    type: "session" as const,
    id: sessionIds[0],
    timestamp: startedAt,
    cwd: agentDir,
  }),
};
let browserFactory!: Function;
const context = {
  cwd: agentDir,
  mode: "tui",
  sessionManager,
  ui: {
    custom(factory: Function) {
      browserFactory = factory;
      return Promise.resolve(null);
    },
    getEditorText: () => "",
    setEditorComponent() {},
    notify() {},
  },
} as unknown as ExtensionContext;

const capture = async (layout: string) => {
  writeLayout(layout);
  await refreshConfig?.({}, context);
  const started = performance.now();
  await stashCommand.handler("", context);
  return performance.now() - started;
};
const component = (rows: number) =>
  browserFactory(
    { terminal: { rows, write() {} }, requestRender() {}, resetDisplay() {} },
    theme,
    undefined,
    () => {},
  );
const median = (samples: number[]) => {
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
};
const measure = (operation: () => void, samples = 51) => {
  operation();
  const times: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    operation();
    times.push(performance.now() - started);
  }
  return median(times);
};
const rounded = (value: number) => Number(value.toFixed(3));

const coldLoad = await capture("Automatic");
const warmLoad = await capture("Automatic");
const scopeToggle = measure(() => {
  const browser = component(60);
  browser.handleInput("g");
  browser.render(120);
});
const search = (query: string) =>
  measure(() => {
    const browser = component(60);
    browser.handleInput("g");
    browser.handleInput("/");
    for (const character of query) browser.handleInput(character);
    browser.render(120);
  });
const literalSearch = search(`fixture ${caseSize - 1}`);
const fuzzySearch = search(`fxtr ${caseSize - 1}`);

await capture("Side by side");
const splitRender = measure(() => component(60).render(120));
await capture("Stacked");
const stackedRender = measure(() => component(60).render(80));
await capture("Compact");
const compactRender = measure(() => component(24).render(40));

console.log(
  JSON.stringify({
    entries: caseSize,
    chats: chatCount,
    coldLoad: rounded(coldLoad),
    warmLoad: rounded(warmLoad),
    scopeToggle: rounded(scopeToggle),
    literalSearch: rounded(literalSearch),
    fuzzySearch: rounded(fuzzySearch),
    splitRender: rounded(splitRender),
    stackedRender: rounded(stackedRender),
    compactRender: rounded(compactRender),
  }),
);
rmSync(agentDir, { recursive: true, force: true });
