import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineVideo } from "tcut";

const root = resolve(import.meta.dir, "..");
const agentDir = join(tmpdir(), "ohmystash-settings-agent");
const sourceAgentDir = join(homedir(), ".omp", "agent");

rmSync(agentDir, { recursive: true, force: true });
mkdirSync(agentDir, { recursive: true, mode: 0o700 });
for (const file of ["config.yml", "models.yml"]) {
  const source = join(sourceAgentDir, file);
  if (existsSync(source)) copyFileSync(source, join(agentDir, file));
}
mkdirSync(join(root, "assets"), { recursive: true });

const ompCommand = [
  `PI_CODING_AGENT_DIR="${agentDir}"`,
  "omp --no-session --no-tools --no-extensions",
  `-e "${join(root, "extensions", "prompt-stash.ts")}"`,
].join(" ");

export default defineVideo(
  {
    output: join(tmpdir(), "ohmystash-settings.svg"),
    requires: ["omp"],
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
    endPause: "1s",
  },
  async (t) => {
    await t.hide(async () => {
      await t.type(ompCommand);
      await t.enter();
      await t.wait(/Welcome back!/, { scope: "screen" });
      await t.sleep("1.5s");
    });

    await t.type("/settings");
    await t.enter();
    await t.wait(/Appearance/, { scope: "screen" });
    await t.right(10);
    await t.wait(/@hkay-dev\/ohmystash/, { scope: "screen" });
    await t.sleep("900ms");
    await t.key("enter");
    await t.wait(/Background brightness/, { scope: "screen" });
    await t.sleep("1.4s");
    await t.snapshot(join(root, "assets", "ohmystash-settings.png"));
    await t.sleep("800ms");

    await t.hide(async () => {
      await t.escape();
      await t.escape();
      await t.ctrl("d");
      await t.sleep("500ms");
    });
  },
);
