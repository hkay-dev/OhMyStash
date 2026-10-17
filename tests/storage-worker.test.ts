import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWindowsAclTransport } from "../extensions/storage-acl-transport.mjs";

const workerPath = fileURLToPath(new URL("../extensions/storage-acl-worker.exe", import.meta.url));
const fixturePath = fileURLToPath(new URL("./storage-worker-fixture.mjs", import.meta.url));
const windowsWorkerTest = test.skipIf(process.platform !== "win32" || !existsSync(workerPath));

windowsWorkerTest("persistent worker compiles the current ACL validator without changing its source", () => {
  const helper = readFileSync(new URL("../extensions/storage-permissions.ps1", import.meta.url), "utf8");
  const native = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/.exec(helper)?.[1];
  expect(native).toBeDefined();
  const built = readFileSync(new URL("../extensions/storage-acl-worker.cs", import.meta.url), "utf8");
  expect(built.startsWith(native + "\n")).toBe(true);
});

windowsWorkerTest("private worker rechecks permissions, rejects foreign clients, and frames large replies", async () => {
  const transport = createWindowsAclTransport(workerPath);
  const fixture = mkdtempSync(join(tmpdir(), "oms-worker-"));
  const root = join(fixture, "private");
  mkdirSync(root);
  try {
    const server = transport.warm();
    expect(transport.request({ action: "prepare", path: root })).toMatchObject({ ok: true });
    expect(transport.request({ action: "tree", path: root })).toMatchObject({ ok: true });
    for (const request of [
      { action: "tree", path: fixture },
      { action: "tree", path: "relative" },
      { action: "invalid", path: root },
    ]) expect(transport.request(request)).toEqual({ ok: false, records: [] });
    const file = join(root, "synthetic.json");
    writeFileSync(file, "{}");
    expect(transport.request({ action: "check", path: file, root })).toMatchObject({ ok: true });
    linkSync(file, join(fixture, "external-link.json"));
    expect(transport.request({ action: "check", path: file, root })).toEqual({ ok: false, records: [] });

    const pipeName = server.name.toString("utf16le").replace(/\0$/, "");
    const foreign = spawnSync(process.execPath, [fixturePath, "foreign-client", pipeName], {
      encoding: "utf8", windowsHide: true, timeout: 4000,
    });
    expect(foreign.status, foreign.stderr).toBe(0);
    expect(foreign.stdout).toContain("foreign-client-rejected");

    const many = join(fixture, "many");
    mkdirSync(many);
    expect(transport.request({ action: "prepare", path: many })).toMatchObject({ ok: true });
    for (let index = 0; index < 400; index++) writeFileSync(join(many, `synthetic-${index}.json`), "{}");
    const large = transport.request({ action: "tree", path: many });
    expect(large).toMatchObject({ ok: true });
    if (!large || typeof large !== "object" || !("records" in large) || !Array.isArray(large.records)) {
      throw new Error("Worker did not return records");
    }
    expect(large.records).toHaveLength(401);
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(65536);
    expect(transport.warm().child.pid).toBe(server.child.pid);

    const exited = once(server.child, "exit");
    server.child.kill();
    await exited;
    expect(transport.request({ action: "tree", path: many })).toMatchObject({ ok: true });

    const orphan = spawnSync(process.execPath, [fixturePath, "orphan-parent", root], {
      encoding: "utf8", windowsHide: true, timeout: 4000,
    });
    expect(orphan.status, orphan.stderr).toBe(0);
    const result: unknown = JSON.parse(orphan.stdout);
    if (!result || typeof result !== "object" || !("workerPid" in result) || typeof result.workerPid !== "number") {
      throw new Error("Missing worker PID");
    }
    const workerPid = result.workerPid;
    // This integration check watches the external .NET parent's real-clock monitor.
    // Fake JavaScript timers cannot advance that worker's clock.
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, 1500);
    await pause.promise;
    expect(() => process.kill(workerPid, 0)).toThrow();
  } finally {
    transport.stop();
  }
}, 15000);

windowsWorkerTest("missing workers fail closed within the configured deadline", () => {
  const missing = createWindowsAclTransport(join(tmpdir(), "oms-does-not-exist", "worker.exe"), 150);
  try {
    expect(() => missing.request({ action: "tree", path: tmpdir() })).toThrow("connection failed");
  } finally {
    missing.stop();
  }
});
