import { spawnSync } from "node:child_process";
import { afterAll, expect, test } from "bun:test";
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStoragePermissions } from "../extensions/storage-permissions.ts";

const testDirectory = mkdtempSync(join(tmpdir(), "oms-permissions-test-"));
afterAll(() => rmSync(testDirectory, { recursive: true, force: true }));

function changedStats(stat: Stats, changes: Partial<Stats>): Stats {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, changes) as Stats;
}

function fixture(name: string) {
  const root = join(testDirectory, name);
  mkdirSync(root);
  const file = join(root, "stash.json");
  writeFileSync(file, '{"text":"keep this stash"}\n');
  return { root, file };
}

function nativeRecord(path: string, safe = true) {
  const stat = lstatSync(path);
  return {
    path: resolve(path), safe,
    ino: String(stat.ino), birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs,
    size: stat.isDirectory() ? 0 : stat.size, directory: stat.isDirectory(), nlink: stat.nlink,
  };
}

for (const platform of ["darwin", "linux"] as const) {
  test(`${platform} checks private modes and the account owner without changing the host platform`, () => {
    const { root, file } = fixture(`posix-${platform}`);
    const permissions = createStoragePermissions({ platform, getuid: () => 1234 });
    for (const [path, mode] of [[root, 0o700], [file, 0o600]] as const) {
      const stat = changedStats(lstatSync(path), { uid: 1234, mode });
      expect(permissions.hasPrivateStoragePermissions(path, stat)).toBe(true);
      expect(permissions.hasPrivateStoragePermissions(path, changedStats(stat, { uid: 5678 }))).toBe(false);
      for (const sharedMode of [0o755, 0o640, 0o666]) {
        expect(permissions.hasPrivateStoragePermissions(path, changedStats(stat, { mode: sharedMode }))).toBe(false);
      }
    }
    const ownerUnknown = createStoragePermissions({ platform, getuid: () => undefined });
    expect(ownerUnknown.hasPrivateStoragePermissions(file, changedStats(lstatSync(file), {
      uid: 5678, mode: 0o600,
    }))).toBe(true);
    expect(ownerUnknown.hasPrivateStoragePermissions(file, changedStats(lstatSync(file), {
      uid: 5678, mode: 0o644,
    }))).toBe(false);
    const noProvisioning = createStoragePermissions({
      platform,
      lstat: () => { throw new Error("POSIX preparation must not touch the filesystem"); },
      native: () => { throw new Error("POSIX preparation must not call Windows"); },
    });
    expect(() => noProvisioning.preparePrivateStorageDirectory("does-not-exist")).not.toThrow();
    expect(() => permissions.withPrivateStoragePermissions(root, () => Promise.resolve())).toThrow("synchronous");
  });
}

test("Windows permissions use native ACLs, not uid or synthetic POSIX mode bits", () => {
  const { root, file } = fixture("windows-metadata");
  const permissions = createStoragePermissions({
    platform: "win32",
    getuid: () => { throw new Error("Windows must not query uid"); },
    lstat: (path) => {
      const stat = lstatSync(path);
      return changedStats(stat, { mode: (stat.mode & ~0o777) | 0o666, uid: 5678 });
    },
    native: (_action, path) => ({ ok: true, records: [nativeRecord(path)] }),
  });
  const stat = lstatSync(file);
  expect(permissions.hasPrivateStoragePermissions(file, changedStats(stat, {
    mode: (stat.mode & ~0o777) | 0o666, uid: 5678,
  }))).toBe(true);
  permissions.preparePrivateStorageDirectory(root);
});

test("native failures, false replies, malformed grants, and changed identities fail closed", () => {
  const { root, file } = fixture("native-failure");
  for (const native of [
    () => { throw new Error("spawn failed: ENOENT"); },
    () => ({ ok: false, records: [] }),
    () => ({ ok: true, records: [{ path: file, safe: true }] }),
    () => ({ ok: true, records: [nativeRecord(file, false)] }),
    () => ({ ok: true, records: [{ ...nativeRecord(file), ino: "0" }] }),
    () => ({ ok: true, records: [nativeRecord(testDirectory)] }),
  ]) {
    const permissions = createStoragePermissions({ platform: "win32", native });
    expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(false);
    expect(() => permissions.preparePrivateStorageDirectory(root)).toThrow();
    let entered = false;
    expect(() => permissions.withPrivateStoragePermissions(root, () => { entered = true; })).toThrow();
    expect(entered).toBe(false);
  }
});

test("batch scopes keep grants only for the synchronous callback and revalidate afterwards", () => {
  const { root, file } = fixture("batch-scope");
  const other = join(root, "other.json");
  writeFileSync(other, "other stash");
  const calls: string[] = [];
  let shared = false;
  const permissions = createStoragePermissions({
    platform: "win32",
    native: (action, path) => {
      calls.push(action);
      return {
        ok: true,
        records: action === "tree" ? [nativeRecord(root), nativeRecord(file), nativeRecord(other)] :
          [nativeRecord(path, !shared)],
      };
    },
  });
  permissions.withPrivateStoragePermissions(root, () => {
    for (let index = 0; index < 5_000; index++) {
      expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(true);
      permissions.preparePrivateStorageDirectory(root);
    }
    unlinkSync(other);
    // Entry changes do not invalidate the directory's identity during a batch.
    expect(permissions.hasPrivateStoragePermissions(root, lstatSync(root))).toBe(true);
    permissions.preparePrivateStorageDirectory(root);
    expect(permissions.hasPrivateStoragePermissions(other, changedStats(lstatSync(file), {}))).toBe(false);
  });
  expect(calls).toEqual(["tree"]);
  shared = true;
  expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(false);
  expect(calls).toEqual(["tree", "check"]);
});

test("scopes reject changed file revisions, missing files, and asynchronous callbacks", () => {
  const { root, file } = fixture("scope-revisions");
  const calls: string[] = [];
  const permissions = createStoragePermissions({
    platform: "win32",
    native: (action, path) => {
      calls.push(action);
      return { ok: true, records: action === "tree" ? [nativeRecord(root), nativeRecord(file)] : [nativeRecord(path)] };
    },
  });
  permissions.withPrivateStoragePermissions(root, () => {
    writeFileSync(file, "changed revision and size");
    expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(false);
  });
  expect(() => permissions.withPrivateStoragePermissions(root, () => Promise.resolve())).toThrow("synchronous");
  expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(true);
  expect(calls).toEqual(["tree", "tree", "check"]);
  expect(() => permissions.withPrivateStoragePermissions(root, () => { throw new Error("callback failed"); })).toThrow("callback failed");
  expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(true);
  expect(calls).toEqual(["tree", "tree", "check", "tree", "check"]);
});

test("prepared root identities prevent ACL changes from triggering another migration", () => {
  const { root } = fixture("prepared-root");
  const calls: string[] = [];
  let safe = true;
  const permissions = createStoragePermissions({
    platform: "win32",
    native: (action, path) => {
      calls.push(action);
      return { ok: true, records: [nativeRecord(path, safe)] };
    },
  });
  permissions.preparePrivateStorageDirectory(root);
  safe = false;
  expect(() => permissions.preparePrivateStorageDirectory(root)).toThrow();
  expect(calls).toEqual(["prepare", "directory"]);
});

test("Windows no-follow checks reject a target fstat passed for a linked path on any host", () => {
  const { root, file } = fixture("simulated-link");
  const alias = join(root, "linked.json");
  let nativeCalls = 0;
  const permissions = createStoragePermissions({
    platform: "win32",
    lstat: (path) => path === alias ? changedStats(lstatSync(file), {
      isSymbolicLink: () => true,
    }) : lstatSync(path),
    native: (action) => {
      nativeCalls += 1;
      if (action !== "tree") throw new Error("Linked paths must not reach native validation");
      return { ok: true, records: [nativeRecord(root), { path: alias, safe: false }] };
    },
  });
  const fd = openSync(file, "r");
  try {
    expect(permissions.hasPrivateStoragePermissions(alias, fstatSync(fd))).toBe(false);
    expect(() => permissions.preparePrivateStorageDirectory(alias)).toThrow();
    expect(nativeCalls).toBe(0);
    permissions.withPrivateStoragePermissions(root, () => {
      expect(permissions.hasPrivateStoragePermissions(alias, fstatSync(fd))).toBe(false);
    });
    expect(nativeCalls).toBe(1);
  } finally {
    closeSync(fd);
  }
});

test("a scoped hardlink spelling cannot borrow a case-distinct sibling's root identity", () => {
  const { root, file } = fixture("case-sensitive-snapshot");
  const outside = fixture("case-sensitive-outside");
  const aliasRoot = root.toUpperCase();
  const aliasFile = join(aliasRoot, "stash.json");
  const calls: string[] = [];
  const leafStat = changedStats(lstatSync(file), { nlink: 2 });
  const permissions = createStoragePermissions({
    platform: "win32",
    lstat: (path) => {
      if (resolve(path) === resolve(aliasRoot)) return lstatSync(outside.root);
      if (resolve(path) === resolve(aliasFile) || resolve(path) === resolve(file)) return leafStat;
      return lstatSync(path);
    },
    native: (action) => {
      calls.push(action);
      return { ok: true, records: [nativeRecord(root), { ...nativeRecord(file), nlink: 2 }] };
    },
  });
  permissions.withPrivateStoragePermissions(root, () => {
    expect(permissions.hasPrivateStoragePermissions(file, leafStat)).toBe(true);
    expect(permissions.hasPrivateStoragePermissions(aliasFile, leafStat)).toBe(false);
    expect(permissions.hasPrivateStoragePermissions(join(aliasRoot, "unknown.json"), leafStat)).toBe(false);
  });
  expect(calls).toEqual(["tree"]);
});

test("new scoped paths require fresh ACL checks and intact snapshot ancestors", () => {
  const { root, file } = fixture("new-scoped-path");
  const calls: string[] = [];
  const permissions = createStoragePermissions({
    platform: "win32",
    native: (action, path) => {
      calls.push(action);
      return { ok: true, records: action === "tree" ? [nativeRecord(root), nativeRecord(file)] : [nativeRecord(path)] };
    },
  });
  permissions.preparePrivateStorageDirectory(root);
  permissions.withPrivateStoragePermissions(root, () => {
    const newFile = join(root, "new.json");
    writeFileSync(newFile, "newly created");
    expect(permissions.hasPrivateStoragePermissions(newFile, lstatSync(newFile))).toBe(true);
    expect(permissions.hasPrivateStoragePermissions(newFile, lstatSync(newFile))).toBe(true);
    const unknownParent = join(root, "new-directory");
    mkdirSync(unknownParent);
    const unknownChild = join(unknownParent, "child.json");
    writeFileSync(unknownChild, "unknown ancestor");
    expect(permissions.hasPrivateStoragePermissions(unknownChild, lstatSync(unknownChild))).toBe(false);
    writeFileSync(file, "changed original snapshot revision");
    expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(false);
  });
  expect(calls).toEqual(["prepare", "tree", "check"]);
});

test("explicit hardlink invalidation refreshes only safe, same-inode scoped file grants", () => {
  const { root, file } = fixture("scoped-invalidation");
  const unsafe = join(root, "unsafe.json");
  const changed = join(root, "changed.json");
  writeFileSync(unsafe, "untrusted ACL");
  writeFileSync(changed, "original");
  const calls: string[] = [];
  const permissions = createStoragePermissions({
    platform: "win32",
    native: (action, path) => {
      calls.push(action);
      return {
        ok: true,
        records: action === "tree" ? [
          nativeRecord(root), nativeRecord(file), nativeRecord(unsafe, false), nativeRecord(changed),
        ] : [nativeRecord(path)],
      };
    },
  });
  permissions.preparePrivateStorageDirectory(root);
  permissions.withPrivateStoragePermissions(root, () => {
    expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(true);
    const display = `${file}.png`;
    linkSync(file, display);
    expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(false);
    permissions.invalidatePrivateStoragePermission(file);
    for (let index = 0; index < 3; index++) {
      expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(true);
    }
    permissions.invalidatePrivateStoragePermission(unsafe);
    expect(permissions.hasPrivateStoragePermissions(unsafe, lstatSync(unsafe))).toBe(false);
    permissions.invalidatePrivateStoragePermission(join(root, "unknown.json"));
    writeFileSync(changed, "changed without explicit invalidation");
    expect(permissions.hasPrivateStoragePermissions(changed, lstatSync(changed))).toBe(false);
    renameSync(changed, `${changed}.old`);
    writeFileSync(changed, "replacement inode");
    permissions.invalidatePrivateStoragePermission(changed);
    expect(permissions.hasPrivateStoragePermissions(changed, lstatSync(changed))).toBe(false);
  });
  expect(calls).toEqual(["prepare", "tree", "check"]);
  // Calling invalidation outside a scope doesn't establish or cache a grant.
  permissions.invalidatePrivateStoragePermission(file);
  expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(true);
  expect(calls).toEqual(["prepare", "tree", "check", "check"]);
});

interface AclFixtureReply {
  supported: boolean;
  user: string;
  defaultOwner: string;
  owner: string;
  protected: boolean;
  rules: { sid: string; inherited: boolean; allow: boolean }[];
  sddl: string;
}

function windowsAcl(action: string, path: string): AclFixtureReply {
  const script = fileURLToPath(new URL("./storage-permissions-fixture.ps1", import.meta.url));
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("SystemRoot is unavailable");
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "psmodulepath") delete environment[key];
  }
  environment.PSModulePath = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
  const result = spawnSync(
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    {
      input: JSON.stringify({ action, path }), encoding: "utf8", windowsHide: true,
      timeout: 30_000, env: environment,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`ACL fixture failed: ${result.error?.message ?? result.stderr}`);
  }
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "")) as AclFixtureReply;
}

const windowsTest = test.skipIf(process.platform !== "win32");

windowsTest("Windows migrates inherited shared directories and existing stash contents without changing bytes", () => {
  const parent = join(testDirectory, "migration-parent");
  mkdirSync(parent);
  windowsAcl("shared-parent", parent);
  const root = join(parent, "stash 'literal' [brackets] ; $variable");
  mkdirSync(root);
  const attachments = join(root, "attachments");
  mkdirSync(attachments);
  const file = join(root, "old.json");
  const asset = join(attachments, "old.bin");
  const bytes = Buffer.from([0, 1, 2, 255]);
  writeFileSync(file, '{"text":"existing secret stash"}\n');
  writeFileSync(asset, bytes);
  const before = windowsAcl("inspect", root);
  expect(before.protected).toBe(false);
  expect(before.rules.some((rule) => rule.sid === "S-1-1-0")).toBe(true);
  expect(before.owner).toBe(before.defaultOwner);
  const permissions = createStoragePermissions();
  expect(permissions.hasPrivateStoragePermissions(root, lstatSync(root))).toBe(false);
  permissions.preparePrivateStorageDirectory(root);
  const after = windowsAcl("inspect", root);
  expect(after.owner).toBe(after.user);
  expect(after.protected).toBe(true);
  expect(after.rules.every((rule) => rule.sid === after.user && rule.allow)).toBe(true);
  expect(permissions.hasPrivateStoragePermissions(root, lstatSync(root))).toBe(true);
  expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(true);
  expect(permissions.hasPrivateStoragePermissions(asset, lstatSync(asset))).toBe(true);
  permissions.preparePrivateStorageDirectory(attachments);
  expect(readFileSync(file, "utf8")).toBe('{"text":"existing secret stash"}\n');
  expect(readFileSync(asset)).toEqual(bytes);
}, 60_000);

windowsTest("new Windows children inherit account-only access even with elevated default ownership", () => {
  const { root } = fixture("new-children");
  const permissions = createStoragePermissions();
  permissions.preparePrivateStorageDirectory(root);
  const file = join(root, "new.json");
  writeFileSync(file, "new secret");
  const child = windowsAcl("inspect", file);
  expect(child.owner).toBe(child.defaultOwner);
  expect(child.rules.every((rule) => rule.sid === child.user && rule.allow && rule.inherited)).toBe(true);
  // An elevated token can assign Administrators as owner without granting it a DACL ACE.
  if (child.defaultOwner === "S-1-5-32-544") expect(child.owner).not.toBe(child.user);
  expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(true);
  const attachments = join(root, "new-attachments");
  mkdirSync(attachments);
  permissions.preparePrivateStorageDirectory(attachments);
  expect(windowsAcl("inspect", attachments).owner).toBe(child.user);
}, 60_000);

windowsTest("Windows rejects broadened root and file ACLs after setup without trusting stat timestamps", () => {
  const { root, file } = fixture("broadened-acls");
  const permissions = createStoragePermissions();
  permissions.preparePrivateStorageDirectory(root);
  const unchangedFileStat = lstatSync(file);
  windowsAcl("broaden", file);
  // Passing the old stat also covers hosts that do not expose ACL revision timestamps.
  expect(permissions.hasPrivateStoragePermissions(file, unchangedFileStat)).toBe(false);
  expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(false);
  permissions.withPrivateStoragePermissions(root, () => {
    expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(false);
  });
  const unchangedRootStat = lstatSync(root);
  windowsAcl("broaden", root);
  expect(permissions.hasPrivateStoragePermissions(root, unchangedRootStat)).toBe(false);
  expect(() => permissions.preparePrivateStorageDirectory(root)).toThrow();
  expect(() => createStoragePermissions().preparePrivateStorageDirectory(root)).toThrow();
  expect(windowsAcl("inspect", root).rules.some((rule) => rule.sid === "S-1-1-0")).toBe(true);
}, 60_000);

windowsTest("Windows rejects foreign owners when the token can assign one", () => {
  const { root, file } = fixture("foreign-owners");
  const permissions = createStoragePermissions();
  permissions.preparePrivateStorageDirectory(root);
  const assigned = windowsAcl("foreign-owner", file);
  if (!assigned.supported) return;
  expect(assigned.owner).toBe("S-1-5-18");
  expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(false);
  permissions.withPrivateStoragePermissions(root, () => {
    expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(false);
  });
  windowsAcl("foreign-owner", root);
  expect(() => permissions.preparePrivateStorageDirectory(root)).toThrow();
  expect(() => createStoragePermissions().preparePrivateStorageDirectory(root)).toThrow();
}, 60_000);

windowsTest("Windows root and descendant junctions never change their external target", () => {
  const { root, file } = fixture("junction-root");
  const external = join(testDirectory, "junction-external");
  mkdirSync(external);
  const externalFile = join(external, "external.json");
  writeFileSync(externalFile, "external data");
  const targetAcl = windowsAcl("inspect", external).sddl;
  const targetFileAcl = windowsAcl("inspect", externalFile).sddl;
  const rootLink = join(testDirectory, "linked-root");
  symlinkSync(external, rootLink, "junction");
  const childLink = join(root, "linked-child");
  symlinkSync(external, childLink, "junction");
  const permissions = createStoragePermissions();
  expect(() => permissions.preparePrivateStorageDirectory(rootLink)).toThrow();
  expect(permissions.hasPrivateStoragePermissions(rootLink, lstatSync(external))).toBe(false);
  permissions.preparePrivateStorageDirectory(root);
  permissions.withPrivateStoragePermissions(root, () => {
    expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(true);
    expect(permissions.hasPrivateStoragePermissions(childLink, lstatSync(external))).toBe(false);
    expect(permissions.hasPrivateStoragePermissions(join(childLink, "external.json"), lstatSync(externalFile))).toBe(false);
    expect(() => permissions.preparePrivateStorageDirectory(childLink)).toThrow();
  });
  expect(permissions.hasPrivateStoragePermissions(join(childLink, "external.json"), lstatSync(externalFile))).toBe(false);
  expect(windowsAcl("inspect", external).sddl).toBe(targetAcl);
  expect(windowsAcl("inspect", externalFile).sddl).toBe(targetFileAcl);
  expect(readFileSync(externalFile, "utf8")).toBe("external data");
}, 60_000);

windowsTest("Windows refuses file symlinks even when the supplied stat comes from fstat", () => {
  const { root } = fixture("file-symlink-root");
  const target = join(testDirectory, "symlink-target.json");
  writeFileSync(target, "outside secret");
  const link = join(root, "linked.json");
  try {
    symlinkSync(target, link, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return;
    throw error;
  }
  const targetAcl = windowsAcl("inspect", target).sddl;
  const fd = openSync(link, "r");
  try {
    const permissions = createStoragePermissions();
    permissions.preparePrivateStorageDirectory(root);
    expect(permissions.hasPrivateStoragePermissions(link, fstatSync(fd))).toBe(false);
    permissions.withPrivateStoragePermissions(root, () => {
      expect(permissions.hasPrivateStoragePermissions(link, fstatSync(fd))).toBe(false);
    });
  } finally {
    closeSync(fd);
  }
  expect(windowsAcl("inspect", target).sddl).toBe(targetAcl);
}, 60_000);

windowsTest("Windows migration rejects external hardlink aliases without changing their ACL", () => {
  const { root } = fixture("hardlink-root");
  const target = join(testDirectory, "hardlink-target.json");
  writeFileSync(target, "outside hardlinked data");
  const link = join(root, "linked.json");
  linkSync(target, link);
  const targetAcl = windowsAcl("inspect", target).sddl;
  const permissions = createStoragePermissions();
  permissions.preparePrivateStorageDirectory(root);
  expect(permissions.hasPrivateStoragePermissions(link, lstatSync(link))).toBe(false);
  permissions.withPrivateStoragePermissions(root, () => {
    expect(permissions.hasPrivateStoragePermissions(link, lstatSync(link))).toBe(false);
  });
  expect(windowsAcl("inspect", target).sddl).toBe(targetAcl);
}, 60_000);

windowsTest("Windows preserves internal canonical/display attachment hardlinks during migration and reads", () => {
  const { root } = fixture("internal-hardlinks");
  const attachments = join(root, "attachments");
  mkdirSync(attachments);
  const canonical = join(attachments, "abcdef");
  const display = `${canonical}.png`;
  writeFileSync(canonical, Buffer.from([0, 127, 255]));
  linkSync(canonical, display);
  const permissions = createStoragePermissions();
  permissions.preparePrivateStorageDirectory(root);
  permissions.preparePrivateStorageDirectory(attachments);
  expect(lstatSync(canonical).nlink).toBe(2);
  expect(permissions.hasPrivateStoragePermissions(canonical, lstatSync(canonical))).toBe(true);
  expect(permissions.hasPrivateStoragePermissions(display, lstatSync(display))).toBe(true);
  permissions.withPrivateStoragePermissions(root, () => {
    expect(permissions.hasPrivateStoragePermissions(canonical, lstatSync(canonical))).toBe(true);
    expect(permissions.hasPrivateStoragePermissions(display, lstatSync(display))).toBe(true);
  });
  const newCanonical = join(attachments, "new-hash");
  const newDisplay = `${newCanonical}.txt`;
  writeFileSync(newCanonical, "new attachment");
  linkSync(newCanonical, newDisplay);
  expect(permissions.hasPrivateStoragePermissions(newCanonical, lstatSync(newCanonical))).toBe(true);
  expect(readFileSync(display)).toEqual(Buffer.from([0, 127, 255]));
  expect(readFileSync(newDisplay, "utf8")).toBe("new attachment");
  // Adding a third, external alias invalidates the same previously accepted inode.
  const external = join(testDirectory, "external-hardlink-alias");
  linkSync(newCanonical, external);
  const externalAcl = windowsAcl("inspect", external).sddl;
  expect(permissions.hasPrivateStoragePermissions(newCanonical, lstatSync(newCanonical))).toBe(false);
  permissions.withPrivateStoragePermissions(root, () => {
    expect(permissions.hasPrivateStoragePermissions(newDisplay, lstatSync(newDisplay))).toBe(false);
  });
  expect(windowsAcl("inspect", external).sddl).toBe(externalAcl);
}, 60_000);

windowsTest("Windows rejects external hardlink aliases under a case-distinct sibling root", () => {
  const parent = join(testDirectory, "native-case-sensitive");
  mkdirSync(parent);
  if (!windowsAcl("case-sensitive", parent).supported) return;
  const root = join(parent, "stash");
  const sibling = join(parent, "STASH");
  mkdirSync(root);
  mkdirSync(sibling);
  expect(lstatSync(root).ino).not.toBe(lstatSync(sibling).ino);
  const permissions = createStoragePermissions();
  permissions.preparePrivateStorageDirectory(sibling);
  const canonical = join(root, "canonical.bin");
  const alias = join(sibling, "external-display.bin");
  writeFileSync(canonical, "case-sensitive external alias");
  linkSync(canonical, alias);
  const aliasAcl = windowsAcl("inspect", alias).sddl;
  const siblingAcl = windowsAcl("inspect", sibling).sddl;
  permissions.preparePrivateStorageDirectory(root);
  expect(permissions.hasPrivateStoragePermissions(canonical, lstatSync(canonical))).toBe(false);
  permissions.withPrivateStoragePermissions(root, () => {
    expect(permissions.hasPrivateStoragePermissions(canonical, lstatSync(canonical))).toBe(false);
    expect(permissions.hasPrivateStoragePermissions(alias, lstatSync(alias))).toBe(false);
  });
  expect(windowsAcl("inspect", alias).sddl).toBe(aliasAcl);
  expect(windowsAcl("inspect", sibling).sddl).toBe(siblingAcl);
  expect(readFileSync(alias, "utf8")).toBe("case-sensitive external alias");
}, 60_000);

windowsTest("Windows scopes validate newly created duplicate attachment aliases once they exist", () => {
  const { root } = fixture("new-scoped-hardlinks");
  const attachments = join(root, "attachments");
  mkdirSync(attachments);
  const permissions = createStoragePermissions();
  permissions.preparePrivateStorageDirectory(root);
  permissions.preparePrivateStorageDirectory(attachments);
  permissions.withPrivateStoragePermissions(root, () => {
    const canonical = join(attachments, "new-canonical");
    const display = `${canonical}.png`;
    writeFileSync(canonical, "duplicate attachment");
    linkSync(canonical, display);
    for (let index = 0; index < 2; index++) {
      expect(permissions.hasPrivateStoragePermissions(canonical, lstatSync(canonical))).toBe(true);
      expect(permissions.hasPrivateStoragePermissions(display, lstatSync(display))).toBe(true);
    }
  });
}, 60_000);

windowsTest("Windows scopes refresh existing canonical grants after intentional display hardlink creation", () => {
  const { root } = fixture("existing-scoped-hardlink");
  const attachments = join(root, "attachments");
  mkdirSync(attachments);
  const permissions = createStoragePermissions();
  permissions.preparePrivateStorageDirectory(root);
  permissions.preparePrivateStorageDirectory(attachments);
  const canonical = join(attachments, "existing-canonical");
  const display = `${canonical}.png`;
  writeFileSync(canonical, "existing attachment without display alias");
  expect(lstatSync(canonical).nlink).toBe(1);
  permissions.withPrivateStoragePermissions(root, () => {
    expect(permissions.hasPrivateStoragePermissions(canonical, lstatSync(canonical))).toBe(true);
    linkSync(canonical, display);
    expect(permissions.hasPrivateStoragePermissions(canonical, lstatSync(canonical))).toBe(false);
    permissions.invalidatePrivateStoragePermission(canonical);
    for (let index = 0; index < 3; index++) {
      expect(permissions.hasPrivateStoragePermissions(canonical, lstatSync(canonical))).toBe(true);
      expect(permissions.hasPrivateStoragePermissions(display, lstatSync(display))).toBe(true);
    }
  });
}, 60_000);

test("a scoped directory replacement cannot reuse the old directory's ACL grant", () => {
  const { root, file } = fixture("directory-replacement");
  const permissions = createStoragePermissions({
    platform: "win32",
    native: () => ({ ok: true, records: [nativeRecord(root), nativeRecord(file)] }),
  });
  permissions.withPrivateStoragePermissions(root, () => {
    renameSync(root, `${root}-old`);
    mkdirSync(root);
    writeFileSync(file, "replacement");
    expect(permissions.hasPrivateStoragePermissions(root, lstatSync(root))).toBe(false);
    expect(permissions.hasPrivateStoragePermissions(file, lstatSync(file))).toBe(false);
    expect(() => permissions.preparePrivateStorageDirectory(root)).toThrow();
  });
});
