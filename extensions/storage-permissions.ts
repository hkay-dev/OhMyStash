import { spawnSync } from "node:child_process";
import { lstatSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface NativeRecord {
  path: string;
  safe: boolean;
  ino?: string;
  birthtimeMs?: number;
  mtimeMs?: number;
  size?: number;
  nlink?: number;
  directory?: boolean;
}

interface NativeReply {
  ok: boolean;
  records: NativeRecord[];
}

type NativeAction = "prepare" | "directory" | "tree" | "check";

interface PermissionDependencies {
  platform: NodeJS.Platform;
  getuid: () => number | undefined;
  lstat: (path: string) => Stats;
  native: (action: NativeAction, path: string, root?: string) => NativeReply;
}

interface ScopedRecord {
  native: NativeRecord;
  stat?: Stats;
}

interface PermissionScope {
  root: string;
  records: Map<string, ScopedRecord>;
}

const helperPath = fileURLToPath(new URL("./storage-permissions.ps1", import.meta.url));

function queryNative(action: NativeAction, path: string, root?: string): NativeReply {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows ACL helper is unavailable");
  const command = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "psmodulepath") delete environment[key];
  }
  environment.PSModulePath = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
  const result = spawnSync(
    command,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath],
    {
      input: JSON.stringify({ action, path, root }),
      encoding: "utf8",
      env: environment,
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) throw new Error("Windows ACL validation failed");
  const reply: unknown = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
  if (
    !reply || typeof reply !== "object" || !("ok" in reply) || reply.ok !== true ||
    !("records" in reply) || !Array.isArray(reply.records)
  ) {
    throw new Error("Windows ACL validation failed");
  }
  return reply as NativeReply;
}

// Dependency injection lets POSIX ownership and native failures be tested on either host.
export function createStoragePermissions(overrides: Partial<PermissionDependencies> = {}) {
  const dependencies: PermissionDependencies = {
    platform: process.platform,
    getuid: () => process.getuid?.(),
    lstat: lstatSync,
    native: queryNative,
    ...overrides,
  };
  // These identities only prevent a second migration. They never cache permission grants.
  const preparedRoots = new Map<string, { path: string; stat: Stats }>();
  let scope: PermissionScope | undefined;

  function pathKey(path: string): string {
    return resolve(path).replaceAll("\\", "/").toLowerCase();
  }

  function sameIdentity(a: Stats, b: Stats): boolean {
    return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs &&
      a.isDirectory() === b.isDirectory() && a.isFile() === b.isFile();
  }

  function sameRevision(a: Stats, b: Stats): boolean {
    return sameIdentity(a, b) && a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs &&
      a.size === b.size && a.nlink === b.nlink;
  }

  function nativeRecords(action: NativeAction, path: string, treeRoot?: string): Map<string, ScopedRecord> {
    const reply = dependencies.native(action, resolve(path), treeRoot);
    if (reply.ok !== true || !Array.isArray(reply.records)) throw new Error("Windows ACL validation failed");
    const root = pathKey(path);
    const records = new Map<string, ScopedRecord>();
    for (const native of reply.records) {
      if (!native || typeof native.path !== "string" || typeof native.safe !== "boolean") {
        throw new Error("Windows ACL validation failed");
      }
      const key = pathKey(native.path);
      if (key !== root && !key.startsWith(`${root}/`)) throw new Error("Windows ACL validation failed");
      if (records.has(key)) throw new Error("Windows ACL validation failed");
      let stat: Stats | undefined;
      if (native.safe) {
        try {
          const current = dependencies.lstat(native.path);
          if (
            typeof native.ino === "string" && Number(native.ino) === current.ino &&
            native.directory === current.isDirectory() &&
            typeof native.birthtimeMs === "number" && Math.abs(native.birthtimeMs - current.birthtimeMs) < 1 &&
            typeof native.mtimeMs === "number" && Math.abs(native.mtimeMs - current.mtimeMs) < 1 &&
            native.size === (current.isDirectory() ? 0 : current.size) &&
            !current.isSymbolicLink() && (current.isDirectory() ||
              (current.isFile() && native.nlink === current.nlink && current.nlink >= 1))
          ) stat = current;
        } catch {}
      }
      records.set(key, { native, stat });
    }
    return records;
  }

  function scopedPermission(path: string, stat: Stats): boolean | undefined {
    if (!scope) return undefined;
    const key = pathKey(path);
    if (key !== scope.root && !key.startsWith(`${scope.root}/`)) return undefined;
    const record = scope.records.get(key);
    if (record && (!record.stat || !record.native.safe)) return false;
    // Walk the requested spelling, not normalized keys, so case-distinct siblings
    // must match the actual snapshot directory identities.
    let ancestorPath = resolve(path);
    let ancestor = key;
    if (!record) {
      ancestorPath = dirname(ancestorPath);
      ancestor = pathKey(ancestorPath);
    }
    while (true) {
      const cached = scope.records.get(ancestor);
      if (!cached?.stat || !cached.native.safe) return false;
      const current = dependencies.lstat(ancestorPath);
      if (current.isSymbolicLink() || !sameIdentity(cached.stat, current)) return false;
      if (ancestor === key) {
        if (!sameRevision(current, stat)) return false;
        if (!current.isDirectory() && !sameRevision(cached.stat, current)) return false;
      }
      if (ancestor === scope.root) return record ? true : undefined;
      ancestorPath = dirname(ancestorPath);
      const parent = pathKey(ancestorPath);
      if (parent === ancestor) return false;
      ancestor = parent;
    }
  }

  function hasPrivateStoragePermissions(path: string, stat: Stats): boolean {
    if (dependencies.platform !== "win32") {
      const uid = dependencies.getuid();
      return (uid === undefined || stat.uid === uid) && (stat.mode & 0o077) === 0;
    }
    try {
      const scoped = scopedPermission(path, stat);
      if (scoped !== undefined) return scoped;
      const current = dependencies.lstat(path);
      if (current.isSymbolicLink() || !sameRevision(current, stat)) return false;
      const key = pathKey(path);
      let treeRoot: string | undefined;
      for (const [root, prepared] of preparedRoots) {
        if ((key === root || key.startsWith(`${root}/`)) && (!treeRoot || root.length > treeRoot.length)) {
          treeRoot = prepared.path;
        }
      }
      const record = nativeRecords("check", path, treeRoot).get(key);
      if (record?.stat && scope && (key === scope.root || key.startsWith(`${scope.root}/`))) {
        scope.records.set(key, record);
      }
      return !!record?.stat && sameRevision(record.stat, stat);
    } catch {
      return false;
    }
  }

  function preparePrivateStorageDirectory(path: string): void {
    if (dependencies.platform !== "win32") return;
    const before = dependencies.lstat(path);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error("OMS storage must be a private real directory");
    }
    const scoped = scopedPermission(path, before);
    if (scoped !== undefined) {
      if (!scoped) throw new Error("OMS storage must be a private real directory");
      return;
    }
    const key = pathKey(path);
    const previous = preparedRoots.get(key);
    const records = nativeRecords(previous && sameIdentity(previous.stat, before) ? "directory" : "prepare", path);
    const record = records.get(key);
    if (!record?.stat || !record.stat.isDirectory() || !sameIdentity(before, record.stat)) {
      throw new Error("OMS storage must be a private real directory");
    }
    preparedRoots.set(key, { path: resolve(path), stat: record.stat });
  }

  function invalidatePrivateStoragePermission(path: string): void {
    if (!scope) return;
    const key = pathKey(path);
    const record = scope.records.get(key);
    if (!record?.native.safe || !record.stat?.isFile()) return;
    try {
      const current = dependencies.lstat(path);
      if (!current.isSymbolicLink() && current.isFile() && sameIdentity(record.stat, current)) {
        scope.records.delete(key);
      }
    } catch {}
  }

  function withPrivateStoragePermissions<T>(root: string, action: () => T): T {
    const previous = scope;
    if (dependencies.platform === "win32") {
      const records = nativeRecords("tree", root);
      const key = pathKey(root);
      const directory = records.get(key);
      if (!directory?.stat?.isDirectory()) throw new Error("OMS storage must be a private real directory");
      scope = { root: key, records };
    }
    try {
      const result = action();
      if (result && (typeof result === "object" || typeof result === "function") &&
        "then" in result && typeof result.then === "function") {
        throw new Error("Private storage permission scopes must be synchronous");
      }
      return result;
    } finally {
      scope = previous;
    }
  }

  return {
    preparePrivateStorageDirectory,
    hasPrivateStoragePermissions,
    invalidatePrivateStoragePermission,
    withPrivateStoragePermissions,
  };
}

export const {
  preparePrivateStorageDirectory,
  hasPrivateStoragePermissions,
  invalidatePrivateStoragePermission,
  withPrivateStoragePermissions,
} = createStoragePermissions();
