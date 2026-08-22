import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineVideo } from "tcut";

const root = resolve(import.meta.dir, "..");
const assetsDir = join(root, "assets");
const features = [
  "scope",
  "search",
  "queue-draft",
  "submit-queue",
  "attachments",
  "editing",
  "locking-deletion",
] as const;
type Feature = (typeof features)[number];
const requestedFeature = process.env.OMS_CAPTURE_FEATURE ?? "scope";
if (!features.includes(requestedFeature as Feature)) {
  throw new Error(`Unknown OMS_CAPTURE_FEATURE: ${requestedFeature}`);
}
const feature = requestedFeature as Feature;
const outputStem =
  feature === "scope" ? "ohmystash-browser" : `ohmystash-feature-${feature}`;
const agentDir = join(tmpdir(), "ohmystash-showcase-agent");
const sourceAgentDir = join(homedir(), ".omp", "agent");
const stashDir = join(agentDir, "prompt-stash");
const attachmentDir = join(stashDir, "attachments");

rmSync(agentDir, { recursive: true, force: true });
mkdirSync(agentDir, { recursive: true, mode: 0o700 });
for (const file of ["config.yml", "models.yml"]) {
  const source = join(sourceAgentDir, file);
  if (existsSync(source)) copyFileSync(source, join(agentDir, file));
}
mkdirSync(stashDir, { recursive: true, mode: 0o700 });
mkdirSync(attachmentDir, { recursive: true, mode: 0o700 });
mkdirSync(assetsDir, { recursive: true });

const imageData = readFileSync(join(root, "assets", "ohmystash-header.png"));
const imageHash = new Bun.SHA256().update(imageData).digest("hex");
const imageRef = `sha256:${imageHash}`;
const imagePath = join(attachmentDir, imageHash);
writeFileSync(imagePath, imageData, { mode: 0o600 });
linkSync(imagePath, `${imagePath}.png`);

const bodyData = Buffer.from("OhMyStash attachment fixture\n".repeat(60_000));
const bodyHash = new Bun.SHA256().update(bodyData).digest("hex");
const bodyRef = `sha256:${bodyHash}`;
writeFileSync(join(attachmentDir, bodyHash), bodyData, { mode: 0o600 });
const now = Date.now();
const fixtures = [
  {
    minutes: 2,
    text: "Document the OhMyStash 1.7 release\n\nCover chat scope, terminal UI, reliability, and the new capture workflow.",
    sessionName: "OhMyStash README",
    workspaceName: "OhMyStash",
    locked: true,
    attachments: [{ kind: "image", ref: imageRef, byteLength: imageData.byteLength, mimeType: "image/png" }],
  },
  {
    minutes: 7,
    text:
      feature === "submit-queue"
        ? 'Reply with exactly "Queue demo started." Do not use tools.'
        : "Compare warm-load performance across 256 stashes",
    sessionName: "Performance review",
    workspaceName: "OhMyStash",
    inputMode: "queue",
  },
  {
    minutes: 16,
    text: "Review the terminal modal dimming and color reset",
    sessionName: "Terminal UI",
    workspaceName: "OhMyStash",
  },
  {
    minutes: 28,
    text: "Verify source-chat metadata on edited and conflicted stashes",
    sessionName: "Persistence audit",
    workspaceName: "ops_workspace",
    preserved: true,
  },
  {
    minutes: 43,
    text: "Queue the attachment recovery regression tests",
    sessionName: "Release checks",
    workspaceName: "OhMyStash",
    inputMode: "queue",
    attachments: [{ kind: "body", ref: bodyRef, byteLength: bodyData.byteLength, charCount: bodyData.byteLength, lineCount: 60_001 }],
  },
  {
    minutes: 68,
    text: "Tighten the README copy around reliability and performance",
    sessionName: "README edits",
    workspaceName: "OhMyStash",
  },
  {
    minutes: 97,
    text: "Inspect the global stash search results for duplicate chat names",
    sessionName: "Search behavior",
    workspaceName: "ops_workspace",
    locked: true,
  },
  {
    minutes: 144,
    text: "Prepare a reusable prompt for release notes",
    sessionName: "Prompt library",
    workspaceName: "OhMyStash",
  },
  {
    minutes: 218,
    text: "Check compact layout controls at narrow terminal widths",
    sessionName: "Responsive browser",
    workspaceName: "OhMyStash",
  },
  {
    minutes: 302,
    text: "Summarize quota and recovery behavior for the docs",
    sessionName: "Storage limits",
    workspaceName: "ops_workspace",
    inputMode: "queue",
  },
  {
    minutes: 418,
    text: "Reproduce the concurrent editor conflict path",
    sessionName: "Concurrency test",
    workspaceName: "OhMyStash",
  },
  {
    minutes: 611,
    text: "Archive the original stash-browser notes",
    legacy: true,
  },
] as const;

for (const fixture of fixtures) {
  const id = randomUUID();
  const stashedAt = new Date(now - fixture.minutes * 60_000).toISOString();
  const preserved = "preserved" in fixture && fixture.preserved === true;
  const payload = {
    id,
    text: fixture.text,
    inputMode: "inputMode" in fixture ? fixture.inputMode : "normal",
    stashedAt,
    ...("legacy" in fixture
      ? {}
      : {
          origin: {
            sessionId: `showcase-${fixture.sessionName.toLowerCase().replaceAll(" ", "-")}`,
            sessionName: fixture.sessionName,
            sessionStartedAt: new Date(now - (fixture.minutes + 45) * 60_000).toISOString(),
            workspaceName: fixture.workspaceName,
          },
        }),
    attachments: "attachments" in fixture ? fixture.attachments : [],
    locked: "locked" in fixture && fixture.locked === true,
    preserved,
  };
  const suffix = preserved ? ".preserved.json" : ".json";
  const path = join(stashDir, `${stashedAt.replaceAll(":", "-")}-${id}${suffix}`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

const ompCommand = [
  "VISUAL= EDITOR=",
  `PI_CODING_AGENT_DIR="${agentDir}"`,
  "omp --no-session --no-tools --no-extensions",
  `-e "${join(root, "extensions", "prompt-stash.ts")}"`,
].join(" ");

export default defineVideo(
  {
    output: [
      join(assetsDir, `${outputStem}.gif`),
      join(assetsDir, `${outputStem}.mp4`),
    ],
    requires: ["omp"],
    theme: "github-dark",
    cols: 104,
    rows: 30,
    width: 1600,
    height: 900,
    fps: 30,
    playbackSpeed: 0.3,
    typingSpeed: "42ms",
    core: "ghostty",
    typingJitter: 0.12,
    seed: 17,
    maxPause: 2_400_000,
    font: {
      family: "Google Sans Code, Symbols Nerd Font Mono",
      size: 24,
      lineHeight: 1.25,
      letterSpacing: 0,
    },
    keys: {
      position: "bottom",
      ttl: "1.1s",
      merge: "300ms",
      limit: 2,
      font: 38,
      color: "#f8fafc",
      background: "#111827",
      radius: 10,
    },
    padding: 18,
    margin: 28,
    marginFill: "#0d1117",
    borderRadius: 14,
    shadow: true,
    cursor: { blink: false, period: 1000 },
    waitTimeout: "20s",
    endPause: "1.2s",
  },
  async (t) => {
    await t.hide(async () => {
      await t.type(ompCommand);
      await t.enter();
      await t.wait(/Welcome back!/, { scope: "screen" });
      await t.sleep("1.5s");
    });

    const openAllChats = async () => {
      await t.type("/stash");
      await t.enter();
      await t.wait(/No stashes in this chat/, { scope: "screen" });
      await t.sleep("900ms");
      await t.type("g");
      await t.wait(/All chats · 1 of 12/, { scope: "screen" });
      await t.sleep("1.2s");
    };
    const finish = async (escapeCount: number) => {
      await t.hide(async () => {
        for (let index = 0; index < escapeCount; index += 1) await t.escape();
        await t.ctrl("c");
        await t.ctrl("d");
        await t.sleep("500ms");
      });
    };

    await t.chapter(feature);
    await openAllChats();

    if (feature === "scope") {
      await t.snapshot(join(assetsDir, "ohmystash-browser.png"));
      await t.sleep("900ms");
      await t.type("g");
      await t.wait(/No stashes in this chat/, { scope: "screen" });
      await t.sleep("1.5s");
      await t.type("g");
      await t.wait(/All chats · 1 of 12/, { scope: "screen" });
      await t.sleep("1.5s");
      await finish(1);
      return;
    }

    if (feature === "search") {
      await t.type("/");
      await t.type("performance");
      await t.wait(/2\/12 matches/, { scope: "screen" });
      await t.sleep("2s");
      await finish(2);
      return;
    }

    if (feature === "queue-draft") {
      await t.down();
      await t.type("q");
      await t.wait(/\/queue Compare warm-load performance/, { scope: "screen" });
      await t.sleep("2s");
      await finish(0);
      return;
    }
    if (feature === "submit-queue") {
      for (let count = 0; count < 6; count += 1) {
        await t.down();
        await t.sleep("100ms");
        await t.type("Q");
        await t.sleep("250ms");
      }
      await t.escape();
      await t.sleep("500ms");
      await finish(0);
      return;
    }

    if (feature === "attachments") {
      await t.type("/");
      await t.type("attachment recovery");
      await t.wait(/1\/12 matches/, { scope: "screen" });
      await t.tab();
      await t.sleep("900ms");
      await t.enter();
      await t.wait(/Pasted 60001 lines/, { scope: "screen" });
      await t.sleep("2s");
      await finish(0);
      return;
    }

    if (feature === "editing") {
      await t.type("/");
      await t.type("terminal modal");
      await t.wait(/1\/12 matches/, { scope: "screen" });
      await t.tab();
      await t.sleep("2s");
      await t.type("e");
      await t.wait(/Edit stashed prompt/, { scope: "screen" });
      await t.sleep("2s");
      await finish(2);
      return;
    }

    await t.type("D");
    await t.wait(/Delete unlocked stashes/, { scope: "screen" });
    await t.sleep("2s");
    await finish(2);
  },
);
