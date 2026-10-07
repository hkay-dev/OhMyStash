import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineVideo } from "tcut";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}; this capture requires a real package artifact and installed compiled OMP.`);
  return value;
}

const root = resolve(import.meta.dir, "..");
const artifact = realpathSync(required("OMS_CAPTURE_ARTIFACT"));
const omp = realpathSync(required("OMS_CAPTURE_OMP"));
const expectedVersion = required("OMS_CAPTURE_OMP_VERSION");
const outputDir = resolve(process.env.OMS_CAPTURE_OUTPUT || join(root, "assets"));
const fixtureDir = mkdtempSync(join(tmpdir(), "ohmystash-release-"));
const home = join(fixtureDir, "home");
const agentDir = join(home, ".omp", "agent");
const cwd = join(fixtureDir, "workspace");
const captureEnv = {
  PATH: process.env.PATH || "/usr/bin:/bin",
  LANG: "en_US.UTF-8",
  TERM: "xterm-256color",
  SHELL: "/bin/bash",
  HOME: home,
  PI_CONFIG_DIR: ".omp",
  PI_CODING_AGENT_DIR: agentDir,
  XDG_CONFIG_HOME: join(fixtureDir, "config"),
  XDG_DATA_HOME: join(fixtureDir, "data"),
  XDG_STATE_HOME: join(fixtureDir, "state"),
  XDG_CACHE_HOME: join(fixtureDir, "cache"),
  TMPDIR: join(fixtureDir, "tmp"),
};

// Bind roots before OMP can import application or extension code. Never inherit profiles or credentials.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, captureEnv);
for (const dir of [agentDir, cwd, outputDir, ...Object.values(captureEnv).filter(value => value.startsWith(fixtureDir))]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
// OMP only opts into these XDG roots when their omp child already exists.
for (const dir of [captureEnv.XDG_DATA_HOME, captureEnv.XDG_STATE_HOME, captureEnv.XDG_CACHE_HOME]) {
  mkdirSync(join(dir, "omp"), { recursive: true, mode: 0o700 });
}
writeFileSync(join(agentDir, "config.yml"), [
  "startup:",
  "  setupWizard: false",
  "  checkUpdate: false",
  "  changelogMode: hidden",
  "marketplace:",
  "  autoUpdate: off",
  "memory:",
  "  backend: off",
  "advisor:",
  "  enabled: false",
  "spelling:",
  "  autocomplete: off",
  "telemetry:",
  "  otlpExportEnabled: false",
  "enabledProviders: []",
  "disabledProviders: [ollama, llama.cpp, lm-studio, apple]",
  "theme:",
  "  dark: titanium",
  "",
].join("\n"), { mode: 0o600 });
// Commands require a selected catalog entry even though this capture never submits inference.
// This is synthetic Flash metadata, not a working model backend or a copied live profile.
writeFileSync(join(agentDir, "models.yml"), JSON.stringify({
  providers: {
    "oms-capture": {
      baseUrl: "https://inference.invalid/v1", api: "openai-completions", auth: "none",
      models: [{
        id: "gemini-3.8-flash", name: "Capture-only Flash catalog entry", reasoning: false,
        input: ["text"], contextWindow: 32000, maxTokens: 2000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  },
}), { mode: 0o600 });

if (!/^(Mach-O|ELF|PE32)/.test(execFileSync("file", ["-b", omp], { env: captureEnv, encoding: "utf8" }))) {
  throw new Error("OMS_CAPTURE_OMP must point to the installed compiled executable, not a source launcher.");
}
const installedVersion = execFileSync(omp, ["--version"], { cwd, env: captureEnv, encoding: "utf8" }).trim();
if (installedVersion !== `omp/${expectedVersion}`) {
  throw new Error(`Expected omp/${expectedVersion}, got ${installedVersion}; review matching-version docs before capturing.`);
}
execFileSync("tar", ["-xzf", artifact, "-C", fixtureDir], { cwd, env: captureEnv });
const packageDir = join(fixtureDir, "package");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
if (manifest.name !== "@hkay-dev/ohmystash") throw new Error("The artifact must contain the OhMyStash npm package.");
const receiptPath = join(outputDir, "ohmystash-release-proof.json");
const proof = {
  status: "prepared",
  omp: { path: omp, version: installedVersion },
  artifact: {
    path: artifact,
    sha256: createHash("sha256").update(readFileSync(artifact)).digest("hex"),
    name: manifest.name,
    version: manifest.version,
  },
  isolation: { fixtureDir, home, agentDir, cwd },
  loader: "isolated artifact and matching SDK peer installation, then omp plugin link and compiled startup",
  peers: {} as Record<string, string>,
  observed: [] as string[],
};
writeFileSync(receiptPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
// Install the actual archive and declared SDK peers in a disposable consumer.
// Linking extracted bytes alone doesn't install their runtime dependencies.
const consumerDir = join(fixtureDir, "consumer");
mkdirSync(consumerDir, { mode: 0o700 });
const peerNames = Object.keys(manifest.peerDependencies ?? {});
writeFileSync(join(consumerDir, "package.json"), JSON.stringify({
  private: true,
  dependencies: {
    [manifest.name]: `file:${artifact}`,
    ...Object.fromEntries(peerNames.map(name => [name, expectedVersion])),
  },
}), { mode: 0o600 });
execFileSync("bun", ["install", "--production", "--ignore-scripts"], {
  cwd: consumerDir, env: captureEnv, stdio: "pipe", timeout: 120_000,
});
for (const name of peerNames) {
  const peer = JSON.parse(readFileSync(join(consumerDir, "node_modules", name, "package.json"), "utf8"));
  if (peer.version !== expectedVersion) throw new Error(`SDK peer ${name} is ${peer.version}, not ${expectedVersion}.`);
  proof.peers[name] = peer.version;
}
execFileSync(omp, ["plugin", "link", join(consumerDir, "node_modules", manifest.name)], {
  cwd, env: captureEnv, stdio: "pipe",
});
writeFileSync(receiptPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });

const draft = "OMS packaged release proof";
function assertIsolatedStash(): void {
  const stashDir = join(agentDir, "prompt-stash");
  const files = readdirSync(stashDir).filter(file => file.endsWith(".json"));
  if (files.length !== 1) throw new Error(`Expected one synthetic stash under ${stashDir}.`);
  const entry = JSON.parse(readFileSync(join(stashDir, files[0]!), "utf8"));
  if (entry.text !== draft || entry.inputMode !== "normal") throw new Error("The isolated stash does not match the draft.");
}
const ompCommand = `'${omp.replaceAll("'", "'\\''")}' --model oms-capture/gemini-3.8-flash --no-session --no-tools --no-lsp --no-title --no-prewalk --no-skills --no-rules; printf '\\nOMS_CAPTURE_DONE exit=%s\\n' "$?"`;

export default defineVideo(
  {
    output: [join(outputDir, "ohmystash-release.mp4"), join(outputDir, "ohmystash-release.gif")],
    cast: join(outputDir, "ohmystash-release.cast"),
    shell: "bash",
    cwd,
    env: captureEnv,
    cache: false,
    theme: "github-dark",
    core: "ghostty",
    cols: 104,
    rows: 30,
    width: 1600,
    height: 900,
    fps: 30,
    font: {
      family: "Google Sans Code, Symbols Nerd Font Mono",
      size: 24,
      lineHeight: 1.25,
      letterSpacing: 0,
    },
    padding: 18,
    margin: 28,
    marginFill: "#0d1117",
    borderRadius: 14,
    shadow: true,
    cursor: { blink: false, period: 1000 },
    waitTimeout: "20s",
    maxPause: "2.4s",
    endPause: "1s",
  },
  async (t) => {
    await t.hide(async () => {
      await t.type(ompCommand);
      await t.enter();
      await t.wait(`v${expectedVersion}`, { scope: "screen" });
      await t.wait("Capture-only Flash catalog entry", { scope: "screen" });
      await t.paste("/stash");
      await t.enter();
      await t.wait(/No stashed prompts/, { scope: "screen" });
    });

    // Never submit the draft or use /queue: no provider request is needed for this proof.
    await t.type(draft);
    await t.alt("s");
    await t.wait(/Prompt stashed \(1 lines\)/, { scope: "screen" });
    assertIsolatedStash();
    await t.alt("s");
    await t.wait(/Prompt restored from/, { scope: "screen" });
    await t.wait(draft, { scope: "screen" });
    await t.sleep("800ms");
    await t.ctrl("a");
    await t.ctrl("k");
    await t.alt("S");
    await t.wait(/OhMyStash/, { scope: "screen" });
    await t.wait(draft, { scope: "screen" });
    await t.sleep("800ms");
    await t.snapshot(join(outputDir, "ohmystash-release-shortcuts.png"));
    await t.sleep("800ms");
    await t.enter();
    await t.wait(/Restored prompt from/, { scope: "screen" });
    await t.wait(draft, { scope: "screen" });
    assertIsolatedStash();

    await t.ctrl("a");
    await t.ctrl("k");
    await t.paste("/settings");
    await t.enter();
    await t.wait(/Appearance/, { scope: "screen" });
    await t.left();
    await t.wait(/@hkay-dev\/ohmystash/, { scope: "screen" });
    await t.enter();
    await t.wait(/Stash shortcut/, { scope: "screen" });
    await t.wait(/Browser shortcut/, { scope: "screen" });
    await t.sleep("1.4s");
    await t.snapshot(join(outputDir, "ohmystash-settings.png"));
    await t.sleep("800ms");

    await t.hide(async () => {
      await t.escape();
      await t.wait(/to configure/, { scope: "screen" });
      await t.escape();
      await t.wait(`v${expectedVersion}`, { scope: "screen" });
      await t.ctrl("d");
      await t.wait(/OMS_CAPTURE_DONE exit=0/, { scope: "screen" });
    });
    proof.status = "consumer-exercised";
    proof.observed = [
      "compiled installed OMP loaded the registered packaged extension",
      "Alt+S saved the synthetic draft under the isolated agent root",
      "Alt+S restored the latest draft",
      "Alt+Shift+S opened the browser and Enter restored its selection",
      "restore retained the one synthetic stash",
      "the packaged plugin settings were visible",
      "OMP exited with status 0",
    ];
    writeFileSync(receiptPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
    rmSync(fixtureDir, { recursive: true, force: true });
  },
);
