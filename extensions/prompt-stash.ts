import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  renameSync,
  type Stats,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components";
import { getEditorCommand, openInEditor } from "@oh-my-pi/pi-coding-agent/utils/external-editor";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
  extractPrintableText,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  replaceTabs,
  truncateToWidth,
  visibleWidth,
  type KeyId,
  type TUI,
} from "@oh-my-pi/pi-tui";
import { SYMBOL_PRESETS } from "@oh-my-pi/pi-tui/theme/symbols";
import { createFrame, extensionIcon, fitToWidth, OVERLAY_OPTIONS } from "./ui";
import {
  hasPrivateStoragePermissions,
  invalidatePrivateStoragePermission,
  preparePrivateStorageDirectory,
  trustCreatedFile,
  withPrivateStoragePermissions,
  warmStoragePermissions,
  stopStoragePermissions,
} from "./storage-permissions";

type InputMode = "normal" | "queue";

type EditorDraft = { inputMode: InputMode; text: string };

type BrowserLayout = "auto" | "split" | "stacked" | "compact";
type BrowserScope = "current" | "all";

type TimeFormat = "12-hour" | "24-hour";

interface PromptStashConfig {
  stashShortcut: string;
  browserShortcut: string;
  editorCommand: string;
  showIcons: boolean;
  layout: BrowserLayout;
  maxBodyRows: number;
  retentionDays: number;
  timeFormat: TimeFormat;
}

type StoredImageAttachment = {
  kind: "image";
  ref: string;
  byteLength: number;
  mimeType: string;
  detail?: ImageContent["detail"];
};

type StoredTextAttachment = {
  kind: "body";
  ref: string;
  byteLength: number;
  charCount: number;
  lineCount: number;
};

type StoredAttachment = StoredImageAttachment | StoredTextAttachment;

type CapturedDraft = EditorDraft & { attachments: StoredAttachment[] };
type StashOrigin = {
  sessionId: string;
  sessionName?: string;
  sessionStartedAt?: string;
  workspaceName?: string;
};

type StashEntry = {
  id: string;
  text: string;
  inputMode: InputMode;
  revision: string;
  stashedAt: string;
  origin?: StashOrigin;
  stashedAtMs: number;
  // The last restore or repeat stash, when there was one. Retention counts from lastUsedMs.
  usedAt?: string;
  lastUsedMs: number;
  fileName: string;
  attachments: StoredAttachment[];
  locked: boolean;
  preserved: boolean;
  displayHeadline: string;
  displayTimestamp: string;
  displayOrigin: string;
  lineCount: number;
  searchText: string;
  searchTextLower?: string;
  searchTextAll: string;
  searchTextAllLower?: string;
};

// The browser state carried between openings. The selection comes back by id, or at the same
// row when that stash is gone.
type BrowserState = { query: string; scope: BrowserScope; selectedId?: string; selectedIndex: number };
type BrowserAction =
  | ({ type: "restore"; entry: StashEntry } & BrowserState)
  | ({ type: "pop"; entry: StashEntry } & BrowserState)
  | ({ type: "queue"; entry: StashEntry } & BrowserState)
  | ({ type: "submit-queue"; entry: StashEntry } & BrowserState)
  | ({ type: "toggle-lock"; entry: StashEntry } & BrowserState)
  | ({ type: "edit"; entry: StashEntry; tui: TUI } & BrowserState)
  | ({ type: "delete"; entry: StashEntry } & BrowserState)
  | ({ type: "delete-all"; entries: StashEntry[] } & BrowserState)
  | null;
// Stash files a load left out, by reason. Damaged files are renamed so they're reported once.
type OmittedFiles = { permissions: number; damaged: number; unsupported: number; overLimit: number };
type LoadResult = { entries: StashEntry[]; omitted: OmittedFiles };
type PreviewModel =
  | { kind: "ascii"; text: string; width: number; totalRows: number }
  | { kind: "grapheme"; text: string; rowStarts: number[]; rowEnds: number[]; totalRows: number };
type CachedEntry = { fingerprint: string; entry: StashEntry };
type PersistedEntry = {
  id: string;
  text: string;
  inputMode: InputMode;
  stashedAt: string;
  origin?: StashOrigin;
  stashedAtMs: number;
  usedAt?: string;
  attachments: StoredAttachment[];
  locked: boolean;
  preserved: boolean;
};

const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_ENTRY_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_FILES = 256;
const MAX_ATTACHMENTS = 64;
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_ATTACHMENT_BYTES = 128 * 1024 * 1024;
// All attachments across chats. Display links share their asset's bytes, so they don't count.
const MAX_ATTACHMENT_STORE_BYTES = 1024 * 1024 * 1024;
const ASSET_REF = /^sha256:([a-f0-9]{64})$/;
// Every asset reference in a stash file's text, which is how garbage collection finds the live ones.
const ASSET_REF_TEXT = /sha256:([a-f0-9]{64})/g;
// A canonical asset is named by its SHA-256, and a display link adds an extension.
const ASSET_FILE = /^([a-f0-9]{64})(\.[a-z0-9][a-z0-9._-]*)?$/;
const ASSET_TEMP = /^\.[0-9a-f-]{36}\.(?:asset|link)\.tmp$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_SESSION_NAME_LENGTH = 512;
const MAX_WORKSPACE_NAME_LENGTH = 255;
const COLLAPSED_PASTE_TOKEN = /\[Paste #[1-9]\d*(?:,[^\]\n]*)?\]/;
const REPLACEMENT_WAIT = new Int32Array(new SharedArrayBuffer(4));
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const STALE_TEMP = /^\.[0-9a-f-]{36}\.tmp$/i;
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
// A temp written this recently may belong to a live writer that has not renamed it yet.
const ACTIVE_TEMP_MS = 60 * 1000;
// Torn writes set aside as .orphan stay for inspection this long, then garbage collection deletes them.
const ORPHAN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const QUOTA_ERROR =
  "OMS storage quota reached across all chats. Open the stash browser to manage it";
const ATTACHMENT_QUOTA_ERROR =
  "OMS attachment storage is full (1 GiB across all chats). Open the stash browser and delete stashes with images or large pastes";
const ENTRY_CACHE = new Map<string, CachedEntry>();
const LOCAL_TIMESTAMP_FORMATTERS = {
  "12-hour": new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }),
  "24-hour": new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }),
} satisfies Record<TimeFormat, Intl.DateTimeFormat>;
const COMPACT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const PLUGIN_NAME = "@hkay-dev/ohmystash";
const DEFAULT_CONFIG: PromptStashConfig = {
  stashShortcut: "alt+s",
  editorCommand: "",
  browserShortcut: "alt+shift+s",
  showIcons: true,
  layout: "auto",
  maxBodyRows: 36,
  retentionDays: 0,
  timeFormat: "12-hour",
};
// The main TUI session's settings. Subagents load this module too, so only the main session's
// session_start writes them.
let pluginConfig = { ...DEFAULT_CONFIG };
const ACTIVE_EDITORS = new WeakMap<object, CustomEditor>();

class EntryConflictError extends Error {}
class StorageQuotaError extends Error {}
// A stored attachment that's damaged or shared with other accounts. `reason` names it in notices.
class AttachmentCheckError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
  }
}

function errorCode(cause: unknown): string | undefined {
  return cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

async function loadPluginConfig(cwd: string): Promise<PromptStashConfig> {
  try {
    const raw = await getPluginSettings(PLUGIN_NAME, cwd);
    const layoutValue = raw["Browser layout"];
    const layout =
      layoutValue === "Side by side"
        ? "split"
        : layoutValue === "Stacked"
          ? "stacked"
          : layoutValue === "Compact"
            ? "compact"
            : "auto";
    const stashShortcut = raw["Stash shortcut"];
    const browserShortcut = raw["Browser shortcut"];
    const editorCommand = raw["Editor command"];
    const showIcons = raw["Show icons"];
    const timeFormat = raw["Time format"];
    return {
      editorCommand:
        typeof editorCommand === "string" ? editorCommand.trim() : DEFAULT_CONFIG.editorCommand,
      stashShortcut:
        typeof stashShortcut === "string" && stashShortcut.trim()
          ? stashShortcut.trim().toLowerCase()
          : DEFAULT_CONFIG.stashShortcut,
      browserShortcut:
        typeof browserShortcut === "string" && browserShortcut.trim()
          ? browserShortcut.trim().toLowerCase()
          : DEFAULT_CONFIG.browserShortcut,
      showIcons: typeof showIcons === "boolean" ? showIcons : DEFAULT_CONFIG.showIcons,
      layout,
      maxBodyRows: Math.round(
        boundedNumber(raw["Maximum body rows"], DEFAULT_CONFIG.maxBodyRows, 6, 72),
      ),
      retentionDays: Math.round(
        boundedNumber(raw["Retention days"], DEFAULT_CONFIG.retentionDays, 0, 3650),
      ),
      timeFormat: timeFormat === "24-hour clock" ? "24-hour" : "12-hour",
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function stashDir(): string {
  return join(getAgentDir(), "prompt-stash");
}

function syncDirectory(path: string): void {
  // Windows doesn't support fsync on directory handles; file fsync still runs.
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncCreatedDirectoryParents(firstCreated: string, leaf: string): void {
  const first = resolve(firstCreated);
  let current = resolve(leaf);
  while (true) {
    const parent = dirname(current);
    syncDirectory(parent);
    if (current === first || parent === current) return;
    current = parent;
  }
}

// Quotes a path for a POSIX shell command in a fix-it message.
function shellPath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

// Names the directory and the fix, each path once so the notice stays short. A store copied with
// shared permissions, for example by cp -r or a sync tool, would otherwise fail every action
// without saying where.
function privateDirectoryError(label: string, dir: string, stat: Stats, cause?: unknown): Error {
  if (stat.isSymbolicLink()) return new Error(`${label} ${dir} is a symbolic link. Replace it with the real directory`);
  if (!stat.isDirectory()) {
    return new Error(`${label} ${dir} is not a directory. Move it aside so OMS can create the directory`);
  }
  if (process.platform === "win32") {
    const detail = cause instanceof Error ? ` (${cause.message})` : "";
    return new Error(`${label} ${dir} must be private to your account${detail}. Remove other accounts from its Security settings`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    return new Error(`${label} belongs to another account. Run: sudo chown -R "$(id -un)" ${shellPath(dir)}`);
  }
  return new Error(`${label} is shared with other accounts. Run: chmod 700 ${shellPath(dir)}`);
}

// How to make stash or attachment files private again, with their path. `pattern` is a shell glob
// that extends the path to several files.
function privateFileFix(path: string, pattern = ""): string {
  return process.platform === "win32"
    ? `Remove other accounts from the Security settings of ${path}${pattern.replaceAll("/", "\\")}`
    : `Run: chmod 600 ${shellPath(path)}${pattern}`;
}

function checkedStashDir(create: boolean): string {
  const dir = stashDir();
  const created = create ? mkdirSync(dir, { recursive: true, mode: 0o700 }) : undefined;
  if (created !== undefined) syncCreatedDirectoryParents(created, dir);
  const stat = lstatSync(dir);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (process.platform !== "win32" && !hasPrivateStoragePermissions(dir, stat))
  ) {
    throw privateDirectoryError("OMS storage directory", dir, stat);
  }
  // Preparation validates native Windows ACLs; POSIX permissions were checked above.
  try {
    preparePrivateStorageDirectory(dir);
  } catch (error) {
    throw privateDirectoryError("OMS storage directory", dir, stat, error);
  }
  return dir;
}

function checkedAttachmentDir(create: boolean): string {
  const root = checkedStashDir(create);
  const dir = join(root, "attachments");
  const created = create ? mkdirSync(dir, { recursive: true, mode: 0o700 }) : undefined;
  if (created !== undefined) syncDirectory(root);
  const stat = lstatSync(dir);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (process.platform !== "win32" && !hasPrivateStoragePermissions(dir, stat))
  ) {
    throw privateDirectoryError("OMS attachment directory", dir, stat);
  }
  try {
    preparePrivateStorageDirectory(dir);
  } catch (error) {
    throw privateDirectoryError("OMS attachment directory", dir, stat, error);
  }
  return dir;
}

// Runs one storage step in one permission scope. On Windows that's one ACL helper launch, because
// the checks inside reuse the scope's snapshot. `attachments` creates the attachment directory
// first, so the snapshot covers it.
function inStore<T>(create: boolean, step: (dir: string) => T, attachments = false): T {
  const dir = stashDir();
  if (create) {
    const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (created !== undefined) syncCreatedDirectoryParents(created, dir);
  }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw privateDirectoryError("OMS storage directory", dir, stat);
  if (create && attachments) {
    try {
      mkdirSync(join(dir, "attachments"), { mode: 0o700 });
      syncDirectory(dir);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  let started = false;
  try {
    return withPrivateStoragePermissions(dir, () => {
      started = true;
      return step(checkedStashDir(false));
    });
  } catch (error) {
    if (started) throw error;
    throw privateDirectoryError("OMS storage directory", dir, stat, error);
  }
}

function assetHash(data: Buffer): string {
  return new Bun.SHA256().update(data).digest("hex");
}

function assetPath(ref: string): string {
  if (!ASSET_REF.test(ref)) throw new Error("OMS attachment reference is invalid");
  return join(checkedAttachmentDir(false), ref.slice("sha256:".length));
}

function readAsset(ref: string, byteLength: number): Buffer {
  if (byteLength < 0 || byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentCheckError("OMS attachment size is invalid", "damaged");
  }
  const path = assetPath(ref);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== byteLength) {
    throw new AttachmentCheckError(`OMS attachment ${path} is damaged: it isn't a regular file of the expected size`, "damaged");
  }
  if (!hasPrivateStoragePermissions(path, stat)) {
    throw new AttachmentCheckError(
      `OMS attachment is shared with other accounts. ${privateFileFix(path)}`,
      "shared with other accounts",
    );
  }
  const data = readFileSync(path);
  if (`sha256:${assetHash(data)}` !== ref) {
    throw new AttachmentCheckError(`OMS attachment ${path} is damaged: it failed its content hash check`, "damaged");
  }
  return data;
}

// A stash is about to reference this asset, so garbage collection treats it as new. Best effort:
// it only narrows the window in which a collection running elsewhere could see it unreferenced.
function touchAsset(path: string): void {
  try {
    const now = new Date();
    utimesSync(path, now, now);
    invalidatePrivateStoragePermission(path);
  } catch {}
}

// Makes displayPath another name for finalPath. A display link left from before a repair still names
// the old bytes, so it's replaced through a temp link and a rename.
function linkDisplayPath(dir: string, finalPath: string, displayPath: string): void {
  if (displayPath === finalPath) return;
  try {
    linkSync(finalPath, displayPath);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const canonical = lstatSync(finalPath);
    const display = lstatSync(displayPath);
    if (!display.isSymbolicLink() && display.isFile() && display.dev === canonical.dev && display.ino === canonical.ino) {
      return;
    }
    const tempLink = join(dir, `.${randomUUID()}.link.tmp`);
    linkSync(finalPath, tempLink);
    try {
      renameSync(tempLink, displayPath);
    } finally {
      try {
        unlinkSync(tempLink);
      } catch {}
    }
  }
  invalidatePrivateStoragePermission(finalPath);
  syncDirectory(dir);
}

// Canonical asset bytes; display links are more names for the same bytes.
function attachmentUsage(attachmentDir: string): number {
  let bytes = 0;
  const handle = opendirSync(attachmentDir);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      const asset = ASSET_FILE.exec(entry.name);
      if (!asset || asset[2] !== undefined) continue;
      try {
        const stat = lstatSync(join(attachmentDir, basename(entry.name)));
        if (stat.isFile()) bytes += stat.size;
      } catch {}
    }
  } finally {
    handle.closeSync();
  }
  return bytes;
}

// New attachment bytes must fit the attachment quota. Unreferenced leftovers are collected before
// giving up, so they never block a save.
function reserveAttachmentSpace(attachmentDir: string, bytes: number): void {
  if (attachmentUsage(attachmentDir) + bytes <= MAX_ATTACHMENT_STORE_BYTES) return;
  collectAttachmentGarbage(dirname(attachmentDir));
  if (attachmentUsage(attachmentDir) + bytes > MAX_ATTACHMENT_STORE_BYTES) {
    throw new StorageQuotaError(ATTACHMENT_QUOTA_ERROR);
  }
}

function persistAsset(data: Buffer, extension?: string): string {
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error("An OMS attachment exceeds the 64 MiB limit");
  }
  const dir = checkedAttachmentDir(true);
  const hash = assetHash(data);
  const ref = `sha256:${hash}`;
  const finalPath = join(dir, hash);
  const displayPath = extension ? `${finalPath}.${extension}` : finalPath;
  // A stored copy that fails its checks gets replaced with these good bytes, instead of failing
  // every later stash of the same image.
  let damaged = false;
  try {
    const existing = readAsset(ref, data.byteLength);
    if (!existing.equals(data)) throw new Error("OMS attachment hash collision");
    touchAsset(finalPath);
    linkDisplayPath(dir, finalPath, displayPath);
    return ref;
  } catch (error) {
    if (error instanceof AttachmentCheckError) damaged = true;
    else if (errorCode(error) !== "ENOENT") throw error;
  }
  if (!damaged) reserveAttachmentSpace(dir, data.byteLength);
  const tempPath = join(dir, `.${randomUUID()}.asset.tmp`);
  let fd: number | undefined;
  let ownsTemp = false;
  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    ownsTemp = true;
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (damaged) {
      renameSync(tempPath, finalPath);
      ownsTemp = false;
      trustCreatedFile(finalPath);
    } else {
      try {
        linkSync(tempPath, finalPath);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const existing = readAsset(ref, data.byteLength);
        if (!existing.equals(data)) throw new Error("OMS attachment hash collision");
      }
      unlinkSync(tempPath);
      ownsTemp = false;
    }
    linkDisplayPath(dir, finalPath, displayPath);
    syncDirectory(dir);
    return ref;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (ownsTemp) {
      try {
        unlinkSync(tempPath);
        syncDirectory(dir);
      } catch {}
    }
    throw error;
  }
}

function attachmentDisplayPath(attachment: StoredImageAttachment): string {
  const canonical = assetPath(attachment.ref);
  const extension = blobExtensionForImageMimeType(attachment.mimeType);
  if (!extension) return canonical;
  const displayPath = `${canonical}.${extension}`;
  try {
    const canonicalStat = lstatSync(canonical);
    const displayStat = lstatSync(displayPath);
    if (
      !displayStat.isSymbolicLink() &&
      displayStat.isFile() &&
      displayStat.dev === canonicalStat.dev &&
      displayStat.ino === canonicalStat.ino
    ) {
      return displayPath;
    }
  } catch {}
  return canonical;
}

function newestCandidateNames(dir: string) {
  const jsonNames: string[] = [];
  const preservedNames: string[] = [];
  const tempNames: string[] = [];
  let total = 0;
  const handle = opendirSync(dir);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (entry.name.endsWith(".preserved.json")) {
        total += 1;
        preservedNames.push(entry.name);
        continue;
      }
      if (entry.name.endsWith(".json")) {
        total += 1;
        const insertAt = jsonNames.findIndex((name) => entry.name > name);
        if (insertAt === -1) {
          if (jsonNames.length < MAX_ENTRY_FILES) jsonNames.push(entry.name);
          continue;
        }
        jsonNames.splice(insertAt, 0, entry.name);
        if (jsonNames.length > MAX_ENTRY_FILES) jsonNames.pop();
        continue;
      }
      if (!STALE_TEMP.test(entry.name)) continue;
      total += 1;
      tempNames.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  const names = [
    ...jsonNames.slice(0, MAX_ENTRY_FILES),
    ...preservedNames,
    ...tempNames,
  ];
  return { names, skipped: Math.max(0, total - names.length), tempCount: tempNames.length };
}

function parseAttachments(value: unknown): StoredAttachment[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return undefined;
  const attachments: StoredAttachment[] = [];
  let totalBytes = 0;
  let bodyCount = 0;
  for (const item of value) {
    if (typeof item !== "object" || item === null) return undefined;
    const raw = item as Record<string, unknown>;
    const ref = raw.ref;
    const byteLength = raw.byteLength;
    if (
      typeof ref !== "string" ||
      !ASSET_REF.test(ref) ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      byteLength > MAX_ATTACHMENT_BYTES
    ) {
      return undefined;
    }
    totalBytes += byteLength;
    if (totalBytes > MAX_ENTRY_ATTACHMENT_BYTES) return undefined;
    if (raw.kind === "image") {
      if (
        typeof raw.mimeType !== "string" ||
        !raw.mimeType.startsWith("image/") ||
        raw.mimeType.length > 128 ||
        (raw.detail !== undefined &&
          raw.detail !== "auto" && raw.detail !== "low" &&
          raw.detail !== "high" && raw.detail !== "original")
      ) {
        return undefined;
      }
      attachments.push({
        kind: "image", ref, byteLength, mimeType: raw.mimeType,
        ...(raw.detail === undefined ? {} : { detail: raw.detail }),
      });
      continue;
    }
    if (
      raw.kind !== "body" ||
      bodyCount > 0 ||
      typeof raw.charCount !== "number" ||
      !Number.isSafeInteger(raw.charCount) ||
      raw.charCount < 0 ||
      typeof raw.lineCount !== "number" ||
      !Number.isSafeInteger(raw.lineCount) ||
      raw.lineCount < 1
    ) {
      return undefined;
    }
    bodyCount += 1;
    attachments.push({
      kind: "body",
      ref,
      byteLength,
      charCount: raw.charCount,
      lineCount: raw.lineCount,
    });
  }
  return attachments;
}
function parseOrigin(value: unknown): StashOrigin | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.sessionId !== "string" ||
    raw.sessionId.length === 0 ||
    raw.sessionId.length > MAX_SESSION_ID_LENGTH
  ) {
    return null;
  }
  if (
    raw.sessionName !== undefined &&
    (typeof raw.sessionName !== "string" ||
      raw.sessionName.length === 0 ||
      raw.sessionName.length > MAX_SESSION_NAME_LENGTH)
  ) {
    return null;
  }
  if (
    raw.workspaceName !== undefined &&
    (typeof raw.workspaceName !== "string" ||
      raw.workspaceName.length === 0 ||
      raw.workspaceName.length > MAX_WORKSPACE_NAME_LENGTH)
  ) {
    return null;
  }
  if (raw.sessionStartedAt !== undefined) {
    if (typeof raw.sessionStartedAt !== "string") return null;
    const startedAt = new Date(raw.sessionStartedAt);
    if (
      !Number.isFinite(startedAt.getTime()) ||
      startedAt.toISOString() !== raw.sessionStartedAt
    ) {
      return null;
    }
  }
  return {
    sessionId: raw.sessionId,
    ...(raw.sessionName === undefined ? {} : { sessionName: raw.sessionName }),
    ...(raw.sessionStartedAt === undefined
      ? {}
      : { sessionStartedAt: raw.sessionStartedAt }),
    ...(raw.workspaceName === undefined ? {} : { workspaceName: raw.workspaceName }),
  };
}

function parsePersistedEntry(text: string): PersistedEntry | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<PersistedEntry>;
    const inputMode =
      parsed.inputMode === undefined || parsed.inputMode === "normal"
        ? "normal"
        : parsed.inputMode === "queue"
          ? "queue"
          : undefined;
    const attachments = parseAttachments(parsed.attachments);
    const origin = parseOrigin(parsed.origin);
    const locked = parsed.locked === undefined ? false : parsed.locked;
    const preserved = parsed.preserved === undefined ? false : parsed.preserved;
    if (
      typeof parsed.id !== "string" ||
      !UUID.test(parsed.id) ||
      typeof parsed.text !== "string" ||
      Buffer.byteLength(parsed.text, "utf8") > MAX_PROMPT_BYTES ||
      inputMode === undefined ||
      attachments === undefined ||
      typeof locked !== "boolean" ||
      typeof preserved !== "boolean" ||
      typeof parsed.stashedAt !== "string"
    ) {
      return undefined;
    }
    const parsedDate = new Date(parsed.stashedAt);
    if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString() !== parsed.stashedAt) {
      return undefined;
    }
    // Versions before 1.12 never wrote usedAt. A malformed one only loses the retention extension.
    const usedDate = typeof parsed.usedAt === "string" ? new Date(parsed.usedAt) : undefined;
    const usedAt = usedDate && Number.isFinite(usedDate.getTime()) && usedDate.toISOString() === parsed.usedAt
      ? parsed.usedAt
      : undefined;
    return {
      id: parsed.id,
      text: parsed.text,
      inputMode,
      stashedAt: parsed.stashedAt,
      origin: origin ?? undefined,
      stashedAtMs: parsedDate.getTime(),
      ...(usedAt === undefined ? {} : { usedAt }),
      attachments,
      locked,
      preserved,
    };
  } catch {
    return undefined;
  }
}

function isRecoverableTemp(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      !hasPrivateStoragePermissions(path, stat) ||
      stat.size <= 0 ||
      stat.size > MAX_ENTRY_FILE_BYTES
    ) {
      return false;
    }
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) return false;
    const entry = parsePersistedEntry(bytes.toString("utf8", 0, bytesRead));
    return entry !== undefined && basename(path) === `.${entry.id}.tmp`;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function cleanupStaleTemps(dir: string): void {
  withPrivateStoragePermissions(dir, () => {
    const cutoff = Date.now() - STALE_TEMP_MS;
    let changed = false;
    const handle = opendirSync(dir);
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (!STALE_TEMP.test(entry.name)) continue;
        const path = join(dir, basename(entry.name));
        try {
          const stat = lstatSync(path);
          if (
            stat.isSymbolicLink() ||
            !stat.isFile() ||
            !hasPrivateStoragePermissions(path, stat) ||
            stat.mtimeMs > cutoff ||
            isRecoverableTemp(path)
          ) {
            continue;
          }
          renameSync(path, `${path}.orphan`);
          changed = true;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") continue;
        }
      }
    } finally {
      handle.closeSync();
    }
    if (changed) syncDirectory(dir);
  });
}

// Removes an orphaned temp, or sets it aside like cleanupStaleTemps does, only while its
// pathname still names the inspected file.
function releaseTemp(path: string, inspected: Stats, setAside = false): void {
  try {
    const current = lstatSync(path);
    if (current.dev !== inspected.dev || current.ino !== inspected.ino) return;
    if (setAside) renameSync(path, `${path}.orphan`);
    else unlinkSync(path);
    syncDirectory(dirname(path));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

// A replacement passes its published name so the old revision is not counted beside its edit.
function storageUsage(dir: string, replacedName?: string) {
  let count = 0;
  let bytes = 0;
  const handle = opendirSync(dir);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (!entry.name.endsWith(".json") && !entry.name.endsWith(".tmp")) continue;
      if (entry.name === replacedName) continue;
      count += 1;
      try {
        const stat = lstatSync(join(dir, basename(entry.name)));
        if (!stat.isSymbolicLink() && stat.isFile()) bytes += stat.size;
      } catch {}
      if (bytes > MAX_TOTAL_BYTES) break;
    }
  } finally {
    handle.closeSync();
  }
  return { count, bytes };
}

function loadEntries(): LoadResult {
  try {
    return inStore(false, (dir) => loadEntriesInDirectory(dir));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return { entries: [], omitted: { permissions: 0, damaged: 0, unsupported: 0, overLimit: 0 } };
  }
}

// Renames a stash file that can never load, once, so it stops warning and counting against the quota.
function setAsideDamaged(path: string, inspected: Stats): void {
  try {
    const current = lstatSync(path);
    if (current.dev !== inspected.dev || current.ino !== inspected.ino) return;
    renameSync(path, `${path}.invalid`);
    syncDirectory(dirname(path));
  } catch {}
}

// Bytes no OhMyStash version could load, unlike an entry this version rejects, which might come from
// a newer version and is left alone.
function isDamagedStashText(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value !== "object" || value === null || Array.isArray(value);
  } catch {
    return true;
  }
}

function loadEntriesInDirectory(dir: string): LoadResult {
  const selection = newestCandidateNames(dir);
  const names = selection.names;
  const entries: StashEntry[] = [];
  const omitted: OmittedFiles = { permissions: 0, damaged: 0, unsupported: 0, overLimit: selection.skipped };
  let totalBytes = 0;
  const seenEntries = selection.tempCount > 0 ? new Map<string, StashEntry>() : undefined;
  let recovered = false;

  for (const fileName of names) {
    const path = join(dir, basename(fileName));
    let fd: number | undefined;
    try {
      fd = openSync(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const stat = fstatSync(fd);
      const preservedFile = fileName.endsWith(".preserved.json");
      const recoveryFile = STALE_TEMP.test(fileName);
      const overflowProtected = preservedFile || recoveryFile;
      const abandoned = recoveryFile && Date.now() - stat.mtimeMs >= ACTIVE_TEMP_MS;
      // An empty temp is a reservation, never a stash, so it is not reported as omitted. Past the
      // live-write window a crash orphaned it, so it is released.
      if (recoveryFile && stat.isFile() && stat.size === 0) {
        if (abandoned) releaseTemp(path, stat);
        continue;
      }
      // Past that window an unrecoverable temp is a torn write. Setting it aside now, as
      // cleanupStaleTemps would after a day, keeps it from blocking changes to its stash.
      if (abandoned && stat.isFile() && hasPrivateStoragePermissions(path, stat) && !isRecoverableTemp(path)) {
        releaseTemp(path, stat, true);
        omitted.damaged += 1;
        continue;
      }
      if (!stat.isFile()) {
        omitted.unsupported += 1;
        continue;
      }
      if (!hasPrivateStoragePermissions(path, stat)) {
        omitted.permissions += 1;
        continue;
      }
      // OhMyStash never publishes an empty stash file or one over the per-file limit.
      if (stat.size <= 0 || stat.size > MAX_ENTRY_FILE_BYTES) {
        if (recoveryFile) {
          omitted.unsupported += 1;
        } else {
          setAsideDamaged(path, stat);
          omitted.damaged += 1;
        }
        continue;
      }
      if (!overflowProtected && totalBytes + stat.size > MAX_TOTAL_BYTES) {
        omitted.overLimit += 1;
        continue;
      }
      if (!overflowProtected) totalBytes += stat.size;
      const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}:${stat.uid}:${pluginConfig.timeFormat}`;
      const cached = recoveryFile ? undefined : ENTRY_CACHE.get(fileName);
      if (cached?.fingerprint === fingerprint) {
        if (seenEntries?.has(cached.entry.id)) {
          continue;
        }
        seenEntries?.set(cached.entry.id, cached.entry);
        entries.push(cached.entry);
        continue;
      }

      const bytes = Buffer.allocUnsafe(stat.size + 1);
      const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) {
        omitted.unsupported += 1;
        continue;
      }
      const text = bytes.toString("utf8", 0, bytesRead);
      const persisted = parsePersistedEntry(text);
      if (
        persisted === undefined ||
        (recoveryFile && fileName !== `.${persisted.id}.tmp`) ||
        (preservedFile && !persisted.preserved)
      ) {
        if (!recoveryFile && persisted === undefined && isDamagedStashText(text)) {
          setAsideDamaged(path, stat);
          omitted.damaged += 1;
        } else {
          omitted.unsupported += 1;
        }
        continue;
      }
      const revision = assetHash(bytes.subarray(0, bytesRead));
      const published = seenEntries?.get(persisted.id);
      if (published) {
        // A stale temp beside its published stash is an orphaned reservation. Keep differing
        // bytes as a conflict copy, then release the pathname so it cannot block later changes.
        if (abandoned) {
          const differs = revision !== published.revision;
          // A session still writing this orphan's copy releases the orphan once the copy lands.
          if (differs && !saveOrphanCopy(dir, persisted, revision, stat)) continue;
          releaseTemp(path, stat);
          recovered ||= differs;
        }
        continue;
      }
      const displayTimestamp = localTimestamp(persisted.stashedAt);
      const displayOrigin = stashOriginLabel(persisted.origin);
      const attachmentSearch = persisted.attachments
        .map((attachment) =>
          attachment.kind === "image"
            ? `image ${attachment.mimeType}`
            : `paste ${attachment.lineCount} lines ${attachment.charCount} chars`,
        )
        .join(" ");
      const searchText = `${persisted.inputMode} ${persisted.locked ? "locked" : ""} ${persisted.preserved ? "preserved conflict" : ""} ${persisted.text}\n${attachmentSearch}\n${displayTimestamp}`;
      const originSearchText = `${displayOrigin} ${persisted.origin?.workspaceName ?? ""} ${persisted.origin?.sessionId ?? ""}`;
      const entry: StashEntry = {
        id: persisted.id,
        text: persisted.text,
        inputMode: persisted.inputMode,
        stashedAt: persisted.stashedAt,
        origin: persisted.origin,
        stashedAtMs: persisted.stashedAtMs,
        ...(persisted.usedAt === undefined ? {} : { usedAt: persisted.usedAt }),
        lastUsedMs: Math.max(
          persisted.stashedAtMs,
          persisted.usedAt === undefined ? 0 : Date.parse(persisted.usedAt),
        ),
        fileName,
        revision,
        attachments: persisted.attachments,
        locked: persisted.locked,
        preserved: persisted.preserved,
        displayHeadline: headline(persisted.text),
        displayTimestamp,
        displayOrigin,
        lineCount: promptLineCount(persisted.text),
        searchText,
        searchTextAll: `${searchText}\n${originSearchText}`,
      };
      entries.push(entry);
      seenEntries?.set(entry.id, entry);
      if (!recoveryFile) ENTRY_CACHE.set(fileName, { fingerprint, entry });
    } catch (error) {
      // A file deleted since the directory was listed is simply gone.
      const code = errorCode(error);
      if (code === "EACCES" || code === "EPERM") omitted.permissions += 1;
      else if (code !== "ENOENT") omitted.unsupported += 1;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  if (recovered) {
    // The second pass no longer sees the files this one set aside, so it carries their count.
    const reloaded = withPrivateStoragePermissions(dir, () => loadEntriesInDirectory(dir));
    reloaded.omitted.damaged += omitted.damaged;
    return reloaded;
  }

  const candidateNames = new Set(names);
  for (const cachedName of ENTRY_CACHE.keys()) {
    if (!candidateNames.has(cachedName)) ENTRY_CACHE.delete(cachedName);
  }

  entries.sort((a, b) => b.stashedAt.localeCompare(a.stashedAt));
  return { entries: pruneExpiredEntries(entries), omitted };
}

function saveEntry(
  text: string,
  inputMode: InputMode,
  attachments: StoredAttachment[],
  origin: StashOrigin | undefined,
  locked = false,
  preserveOnQuota = false,
  // A fixed identity names one pathname, so however often it is saved it is published once.
  identity?: { id: string; stashedAt: string },
): void {
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error("Prompt is too large to stash safely");
  }

  const dir = checkedStashDir(true);
  cleanupStaleTemps(dir);
  const id = identity?.id ?? randomUUID();
  const stashedAt = identity?.stashedAt ?? new Date().toISOString();
  const fileName = `${stashedAt.replaceAll(":", "-")}-${id}${preserveOnQuota ? ".preserved.json" : ".json"}`;
  const finalPath = join(dir, fileName);
  const tempPath = join(dir, `.${id}.tmp`);
  const payload = `${JSON.stringify({ id, text, inputMode, stashedAt, origin, attachments, locked, preserved: preserveOnQuota }, null, 2)}\n`;
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (payloadBytes > MAX_ENTRY_FILE_BYTES) {
    throw new Error("Serialized prompt is too large to stash safely");
  }

  let fd: number | undefined;
  let ownsTemp = false;
  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    ownsTemp = true;
    writeFileSync(fd, payload, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const usage = storageUsage(dir);
    if (
      !preserveOnQuota &&
      (usage.count > MAX_ENTRY_FILES || usage.bytes > MAX_TOTAL_BYTES)
    ) {
      throw new StorageQuotaError(QUOTA_ERROR);
    }
    checkedStashDir(false);
    // The published file is this save's own temp, so later checks in this scope can trust it.
    if (identity) {
      let linked = true;
      try {
        linkSync(tempPath, finalPath);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        linked = false;
      }
      unlinkSync(tempPath);
      if (linked) trustCreatedFile(finalPath);
    } else {
      renameSync(tempPath, finalPath);
      trustCreatedFile(finalPath);
    }
    ownsTemp = false;
    syncDirectory(dir);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (ownsTemp) {
      try {
        unlinkSync(tempPath);
        syncDirectory(dir);
      } catch {}
    }
    throw error;
  }
}

// Keeps an orphaned edit as a preserved conflict copy. The copy's id and timestamp derive from the
// orphan, so sessions converting it at once, or again after a failed release, publish one copy.
// Returns false while another session may still be writing that copy's temp.
function saveOrphanCopy(dir: string, orphan: PersistedEntry, revision: string, stat: Stats): boolean {
  const stashedAt = new Date(stat.mtimeMs).toISOString();
  const hash = assetHash(Buffer.from(`${revision}:${stashedAt}`));
  // RFC 9562 version 8 layout, so the id passes the same check as random ones.
  const variant = "89ab".charAt(Number.parseInt(hash.charAt(16), 16) % 4);
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  try {
    saveEntry(orphan.text, orphan.inputMode, orphan.attachments, orphan.origin, orphan.locked, true, { id, stashedAt });
    return true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  // A complete copy temp past the live-write window was left by a crash before saveEntry could
  // publish it. Publishing it here keeps the orphan, and so its stash, from staying blocked.
  const tempPath = join(dir, `.${id}.tmp`);
  try {
    const temp = lstatSync(tempPath);
    if (Date.now() - temp.mtimeMs < ACTIVE_TEMP_MS || !isRecoverableTemp(tempPath)) return false;
    try {
      linkSync(tempPath, join(dir, `${stashedAt.replaceAll(":", "-")}-${id}.preserved.json`));
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    releaseTemp(tempPath, temp);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function openReplacementTemp(path: string): number {
  const deadline = Date.now() + 500;
  while (true) {
    try {
      return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new EntryConflictError("Another process is updating this stash");
      }
      Atomics.wait(REPLACEMENT_WAIT, 0, 0, 2);
    }
  }
}

// Publishes a recovery temp under its stash name before the stash changes. A recently written
// temp may belong to a live writer that will still rename it, so it is never claimed.
function publishRecovery(dir: string, entry: StashEntry): string {
  const publishedName = `${entry.stashedAt.replaceAll(":", "-")}-${entry.id}${entry.preserved ? ".preserved.json" : ".json"}`;
  const sourcePath = join(dir, basename(entry.fileName));
  try {
    if (Date.now() - lstatSync(sourcePath).mtimeMs < ACTIVE_TEMP_MS) {
      throw new EntryConflictError("Another process is updating this stash");
    }
    // Publish recovery only if no other writer has published this stash.
    linkSync(sourcePath, join(dir, publishedName));
    unlinkSync(sourcePath);
    syncDirectory(dir);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new EntryConflictError("Stash was published while its recovery file was being changed");
    }
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return publishedName;
}

function replaceEntry(
  entry: StashEntry,
  text: string,
  attachments: StoredAttachment[],
  locked: boolean,
  usedAt = entry.usedAt,
): void {
  const dir = checkedStashDir(false);
  const publishedName = STALE_TEMP.test(entry.fileName)
    ? publishRecovery(dir, entry)
    : entry.preserved
      ? basename(entry.fileName)
      : `${entry.stashedAt.replaceAll(":", "-")}-${entry.id}.json`;
  const finalPath = join(dir, publishedName);
  const tempPath = join(dir, `.${entry.id}.tmp`);
  const payload = `${JSON.stringify({
    id: entry.id,
    text,
    inputMode: entry.inputMode,
    stashedAt: entry.stashedAt,
    ...(usedAt === undefined ? {} : { usedAt }),
    origin: entry.origin,
    attachments,
    locked,
    preserved: entry.preserved,
  }, null, 2)}\n`;
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (payloadBytes > MAX_ENTRY_FILE_BYTES) {
    throw new Error("Edited prompt is too large to persist safely");
  }
  let fd: number | undefined;
  let ownsTemp = false;
  try {
    fd = openReplacementTemp(tempPath);
    ownsTemp = true;
    let current: Buffer;
    try {
      current = readFileSync(finalPath);
    } catch {
      throw new EntryConflictError("Stash changed while it was being edited");
    }
    if (assetHash(current) !== entry.revision) {
      throw new EntryConflictError("Stash changed while it was being edited");
    }
    // Loading drops normal stashes past the metadata budget, so an edit must not grow past it.
    // A lock toggle only flips a flag and stays allowed, or a full store could never be unlocked
    // and cleaned up.
    if (
      !entry.preserved &&
      (text !== entry.text || attachments !== entry.attachments) &&
      payloadBytes > current.length &&
      storageUsage(dir, publishedName).bytes + payloadBytes > MAX_TOTAL_BYTES
    ) {
      throw new StorageQuotaError(QUOTA_ERROR);
    }
    writeFileSync(fd, payload, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, finalPath);
    ownsTemp = false;
    trustCreatedFile(finalPath);
    syncDirectory(dir);
    ENTRY_CACHE.delete(entry.fileName);
    ENTRY_CACHE.delete(publishedName);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (ownsTemp) {
      try {
        unlinkSync(tempPath);
        syncDirectory(dir);
      } catch {}
    }
    throw error;
  }
}

function setEntryLocked(entry: StashEntry, locked: boolean): void {
  replaceEntry(entry, entry.text, entry.attachments, locked);
}

// Retention counts from the last restore, so a stash you keep reusing doesn't expire. This is best
// effort: a failure must not undo or fail a restore that already happened.
function markEntryUsed(entry: StashEntry): void {
  if (entry.locked || entry.preserved || STALE_TEMP.test(entry.fileName)) return;
  try {
    replaceEntry(entry, entry.text, entry.attachments, entry.locked, new Date().toISOString());
  } catch {}
}

function setEntryText(entry: StashEntry, editedText: string): "updated" | "conflict-copy" | "quota-copy" {
  const images = entry.attachments.filter(
    (attachment): attachment is StoredImageAttachment => attachment.kind === "image",
  );
  if (editedText.length === 0 && images.length === 0) {
    throw new Error("An attachment-free stash cannot be edited to an empty prompt");
  }
  const imageBytes = images.reduce((total, image) => total + image.byteLength, 0);
  const textBytes = Buffer.byteLength(editedText, "utf8");
  let text = editedText;
  let attachments: StoredAttachment[] = images;
  if (textBytes > MAX_PROMPT_BYTES) {
    if (images.length >= MAX_ATTACHMENTS) {
      throw new Error(`An OMS entry can contain at most ${MAX_ATTACHMENTS} attachments, including the large text body`);
    }
    if (
      textBytes > MAX_ATTACHMENT_BYTES ||
      imageBytes + textBytes > MAX_ENTRY_ATTACHMENT_BYTES
    ) {
      throw new Error("Edited prompt exceeds the file-backed attachment limit");
    }
    const ref = persistAsset(Buffer.from(editedText, "utf8"), "txt");
    const body: StoredTextAttachment = {
      kind: "body",
      ref,
      byteLength: textBytes,
      charCount: editedText.length,
      lineCount: promptLineCount(editedText),
    };
    text = `[Large pasted prompt · ${body.lineCount} lines · ${body.charCount} chars]`;
    attachments = [...images, body];
  }
  try {
    replaceEntry(entry, text, attachments, entry.locked);
    return "updated";
  } catch (error) {
    if (!(error instanceof EntryConflictError) && !(error instanceof StorageQuotaError)) throw error;
    // Either way the edit survives as a preserved copy, which the quota and load budget exempt.
    saveEntry(text, entry.inputMode, attachments, entry.origin, entry.locked, true);
    return error instanceof StorageQuotaError ? "quota-copy" : "conflict-copy";
  }
}

// Publication only ever links, so an interrupted one leaves the reservation pathname as a second
// hard link to the stash. Deleting the stash must delete that alias too, or the prompt comes back.
function releaseAlias(tempPath: string, path: string): void {
  try {
    const temp = lstatSync(tempPath, { bigint: true });
    const target = lstatSync(path, { bigint: true });
    if (temp.isFile() && temp.dev === target.dev && temp.ino === target.ino) {
      unlinkSync(tempPath);
      invalidatePrivateStoragePermission(path);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function removeEntry(entry: StashEntry, sync = true): boolean {
  const dir = checkedStashDir(false);
  const fileName = STALE_TEMP.test(entry.fileName)
    ? publishRecovery(dir, entry)
    : basename(entry.fileName);
  const path = join(dir, fileName);
  const tempPath = join(dir, `.${entry.id}.tmp`);
  releaseAlias(tempPath, path);
  // Deletion holds the replacement reservation, so a concurrent edit or lock is never lost.
  const fd = openReplacementTemp(tempPath);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`OMS stash file ${path} isn't a regular file`);
    }
    if (!hasPrivateStoragePermissions(path, stat)) {
      throw new Error(`OMS stash file is shared with other accounts. ${privateFileFix(path)}`);
    }
    const bytes = readFileSync(path);
    const persisted = parsePersistedEntry(bytes.toString("utf8"));
    if (!persisted) throw new Error("Selected OMS entry changed and cannot be deleted safely");
    if (assetHash(bytes) !== entry.revision) {
      throw new EntryConflictError("Stash changed after the browser loaded");
    }
    if (persisted.locked) throw new Error("Locked stashes must be unlocked before deletion");
    unlinkSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  } finally {
    closeSync(fd);
    try {
      unlinkSync(tempPath);
    } catch {}
    ENTRY_CACHE.delete(entry.fileName);
    ENTRY_CACHE.delete(fileName);
    if (sync) syncDirectory(dir);
  }
}

function removeEntries(entries: StashEntry[]): number {
  const dir = checkedStashDir(false);
  return withPrivateStoragePermissions(dir, () => {
    let deleted = 0;
    for (const entry of entries) {
      try {
        if (removeEntry(entry, false)) deleted += 1;
      } catch {
        // A concurrent lock, edit, or safety-check failure keeps that stash; the summary shows it.
      }
    }
    syncDirectory(dir);
    collectAttachmentGarbage(dir);
    return deleted;
  });
}

// Deletes assets and display links that no stash file names any more, once they're older than a
// live save's window, plus stale asset temps and old .orphan files. Every stash, conflict copy,
// recovery temp, and set-aside file counts, read as text so a damaged one still keeps its
// assets. If one can't be read, nothing is deleted.
function collectAttachmentGarbage(dir: string): void {
  const attachmentDir = join(dir, "attachments");
  try {
    const stat = lstatSync(attachmentDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  } catch {
    return;
  }
  // Saving touches a reused asset and writes new ones, so mtime marks an asset's last use.
  const now = Date.now();
  const referenced = new Set<string>();
  let removedOrphan = false;
  const handle = opendirSync(dir);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      const name = entry.name;
      const orphan = name.endsWith(".orphan");
      if (!orphan && !name.endsWith(".json") && !name.endsWith(".tmp") && !name.endsWith(".invalid")) continue;
      const path = join(dir, basename(name));
      let text: string;
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        if (orphan && now - stat.mtimeMs >= ORPHAN_KEEP_MS) {
          unlinkSync(path);
          removedOrphan = true;
          continue;
        }
        // OhMyStash never writes a stash file over the per-file limit, so a larger one names nothing.
        if (stat.size > MAX_ENTRY_FILE_BYTES) continue;
        text = readFileSync(path, "latin1");
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        return;
      }
      for (const match of text.matchAll(ASSET_REF_TEXT)) referenced.add(match[1] as string);
    }
  } finally {
    handle.closeSync();
  }
  if (removedOrphan) syncDirectory(dir);
  let removed = false;
  const assets = opendirSync(attachmentDir);
  try {
    for (let entry = assets.readSync(); entry !== null; entry = assets.readSync()) {
      const asset = ASSET_FILE.exec(entry.name);
      if (asset ? referenced.has(asset[1] as string) : !ASSET_TEMP.test(entry.name)) continue;
      const path = join(attachmentDir, basename(entry.name));
      try {
        const stat = lstatSync(path);
        if (stat.isDirectory() || now - stat.mtimeMs < (asset ? ACTIVE_TEMP_MS : STALE_TEMP_MS)) continue;
        unlinkSync(path);
        removed = true;
      } catch {}
    }
  } finally {
    assets.closeSync();
  }
  if (removed) syncDirectory(attachmentDir);
}

function pruneExpiredEntries(entries: StashEntry[]): StashEntry[] {
  if (pluginConfig.retentionDays <= 0) return entries;
  const cutoff = Date.now() - pluginConfig.retentionDays * 86_400_000;
  let removedNames: Set<string> | undefined;
  for (const entry of entries) {
    if (
      entry.locked ||
      entry.preserved ||
      STALE_TEMP.test(entry.fileName) ||
      entry.lastUsedMs >= cutoff
    ) {
      continue;
    }
    try {
      if (removeEntry(entry, false)) {
        (removedNames ??= new Set()).add(entry.fileName);
      }
    } catch {
      // A concurrent lock, edit, or safety-check failure keeps the stash.
    }
  }
  if (!removedNames) return entries;
  const dir = checkedStashDir(false);
  syncDirectory(dir);
  collectAttachmentGarbage(dir);
  return entries.filter((entry) => !removedNames.has(entry.fileName));
}

function displayText(text: string): string {
  return replaceTabs(text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
    "�",
  );
}

function headline(text: string): string {
  const safe = displayText(text);
  let start = 0;
  while (start <= safe.length) {
    const newline = safe.indexOf("\n", start);
    const end = newline === -1 ? safe.length : newline;
    const line = safe.slice(start, end).trim();
    // A list row never shows more, and each render truncates every visible headline.
    if (line) return line.slice(0, 1024);
    if (newline === -1) break;
    start = newline + 1;
  }
  return "(empty prompt)";
}

function currentStashOrigin(ctx: ExtensionContext): StashOrigin {
  const sessionId = ctx.sessionManager.getSessionId();
  if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) {
    throw new Error("OMP returned an invalid session ID");
  }
  const sessionName = ctx.sessionManager.getSessionName()?.trim().slice(0, MAX_SESSION_NAME_LENGTH);
  const headerTimestamp = ctx.sessionManager.getHeader()?.timestamp;
  const startedAt = headerTimestamp === undefined ? undefined : new Date(headerTimestamp);
  const sessionStartedAt =
    startedAt !== undefined &&
    Number.isFinite(startedAt.getTime()) &&
    startedAt.toISOString() === headerTimestamp
      ? headerTimestamp
      : undefined;
  const workspaceName = (basename(resolve(ctx.cwd)) || "/").slice(
    0,
    MAX_WORKSPACE_NAME_LENGTH,
  );
  return {
    sessionId,
    ...(sessionName ? { sessionName } : {}),
    ...(sessionStartedAt ? { sessionStartedAt } : {}),
    ...(workspaceName ? { workspaceName } : {}),
  };
}

function stashOriginLabel(origin: StashOrigin | undefined): string {
  if (!origin) return "Before chat tracking";
  const chat = origin.sessionName ? displayText(origin.sessionName) : "Untitled chat";
  const workspace = origin.workspaceName ? displayText(origin.workspaceName) : "";
  const shortId = origin.sessionId.slice(0, 8);
  return `${chat}${workspace ? ` · ${workspace}` : ""}${origin.sessionName ? "" : ` · ${shortId}`}`;
}

function stashOriginDetails(origin: StashOrigin | undefined): string {
  if (!origin) return "Chat: Before chat tracking";
  const chat = origin.sessionName ? displayText(origin.sessionName) : "Untitled chat";
  const workspace = origin.workspaceName ? displayText(origin.workspaceName) : "Unknown";
  const started = origin.sessionStartedAt ? localTimestamp(origin.sessionStartedAt) : "Unknown";
  return `Chat: ${chat} · Workspace: ${workspace} · Started: ${started} · Session: ${origin.sessionId.slice(0, 8)}`;
}

function isCurrentChat(entry: StashEntry, sessionId: string): boolean {
  return entry.origin?.sessionId === sessionId;
}

function localTimestamp(iso: string): string {
  const parts = LOCAL_TIMESTAMP_FORMATTERS[pluginConfig.timeFormat].formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const dayPeriod = pluginConfig.timeFormat === "12-hour" ? ` ${value("dayPeriod")}` : "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}${dayPeriod}`;
}

function promptLineCount(text: string): number {
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n" || (text[index] === "\r" && text[index + 1] !== "\n")) count += 1;
  }
  return count;
}

// The first character past printable ASCII. displayText already turned tabs into spaces and control
// characters into U+FFFD, so the newline is the only other ASCII character left.
const NON_ASCII = /[^\x20-\x7e\n]/g;

function buildPreviewModel(text: string, width: number): PreviewModel {
  const safe = displayText(text);
  const safeWidth = Math.max(1, width);
  NON_ASCII.lastIndex = 0;
  let wide = NON_ASCII.exec(safe)?.index ?? -1;

  if (wide === -1) {
    let totalRows = 0;
    let lineStart = 0;
    for (let index = 0; index <= safe.length; index += 1) {
      if (index !== safe.length && safe[index] !== "\n") continue;
      totalRows += Math.max(1, Math.ceil((index - lineStart) / safeWidth));
      lineStart = index + 1;
    }
    return { kind: "ascii", text: safe, width: safeWidth, totalRows };
  }

  // Printable ASCII lines still wrap by character count. Only a line with other characters is split
  // into graphemes and measured, so one curly quote doesn't slow down the whole preview.
  const rowStarts: number[] = [];
  const rowEnds: number[] = [];
  let lineStart = 0;
  while (true) {
    const newline = safe.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? safe.length : newline;
    if (wide !== -1 && wide < lineStart) {
      NON_ASCII.lastIndex = lineStart;
      wide = NON_ASCII.exec(safe)?.index ?? -1;
    }
    if (wide === -1 || wide >= lineEnd) {
      if (lineEnd === lineStart) {
        rowStarts.push(lineStart);
        rowEnds.push(lineStart);
      }
      for (let start = lineStart; start < lineEnd; start += safeWidth) {
        rowStarts.push(start);
        rowEnds.push(Math.min(lineEnd, start + safeWidth));
      }
    } else {
      let rowStart = lineStart;
      let rowWidth = 0;
      for (const part of GRAPHEME_SEGMENTER.segment(safe.slice(lineStart, lineEnd))) {
        const graphemeWidth = visibleWidth(part.segment);
        if (rowWidth > 0 && rowWidth + graphemeWidth > safeWidth) {
          rowStarts.push(rowStart);
          rowEnds.push(lineStart + part.index);
          rowStart = lineStart + part.index;
          rowWidth = 0;
        }
        rowWidth += graphemeWidth;
      }
      rowStarts.push(rowStart);
      rowEnds.push(lineEnd);
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return { kind: "grapheme", text: safe, rowStarts, rowEnds, totalRows: rowStarts.length };
}

function previewPage(model: PreviewModel, offset: number, count: number): string[] {
  const page: string[] = [];
  if (model.kind === "grapheme") {
    const end = Math.min(model.totalRows, offset + count);
    for (let row = offset; row < end; row += 1) {
      page.push(model.text.slice(model.rowStarts[row], model.rowEnds[row]));
    }
    return page;
  }

  let globalRow = 0;
  let lineStart = 0;
  for (let index = 0; index <= model.text.length && page.length < count; index += 1) {
    if (index !== model.text.length && model.text[index] !== "\n") continue;
    const lineEnd = index;
    const rows = Math.max(1, Math.ceil((lineEnd - lineStart) / model.width));
    const firstRow = Math.max(0, offset - globalRow);
    if (globalRow + rows > offset) {
      for (let row = firstRow; row < rows && page.length < count; row += 1) {
        const start = lineStart + row * model.width;
        page.push(model.text.slice(start, Math.min(lineEnd, start + model.width)));
      }
    }
    globalRow += rows;
    lineStart = index + 1;
  }
  return page;
}

function parseEditorDraft(text: string): EditorDraft {
  if (text === "/queue") return { inputMode: "queue", text: "" };
  if (/^\/queue[ \t\n]/.test(text)) return { inputMode: "queue", text: text.slice(7) };
  return { inputMode: "normal", text };
}

function activeEditor(ctx: ExtensionContext): CustomEditor | undefined {
  const editor = ACTIVE_EDITORS.get(ctx.sessionManager);
  // Another extension can swap the composer later; a replaced editor never regains focus.
  return editor?.tui && editor.tui.getFocused() !== editor ? undefined : editor;
}

function hasEditorContent(ctx: ExtensionContext): boolean {
  // Attachments live as chip tokens in the text; pendingImages also keeps deleted chips' images.
  return parseEditorDraft(ctx.ui.getEditorText()).text.length > 0;
}

function installEditorBridge(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const sessionManager = ctx.sessionManager;
  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    // OMP hands only text to a new composer, so keep the live one with its pasted payloads.
    const focused = tui.getFocused?.();
    const editor = focused instanceof CustomEditor ? focused : new CustomEditor(tui, theme, keybindings);
    if (editor === focused) editor.tui ??= tui;
    ACTIVE_EDITORS.set(sessionManager, editor);
    return editor;
  });
}

// Compiled OMP does not serve pi-tui's prompt/* modules to extensions, so OMP's attachment token
// logic is mirrored here. Chips read "<icon> #N" with an icon from any symbol preset.
const VISION_MARKER = /\[(Image|Video) #([1-9]\d*)((?:,[^\]\n]*)?)\](?: attachment:\/\/(\2))?/g;
const ATTACHMENT_TOKEN = new RegExp(
  `\\[(?:Image|Video) #[1-9]\\d*(?:,[^\\]\\n]*)?\\]|(?:${Object.values(SYMBOL_PRESETS)
    .flatMap((preset) => [preset["chip.image"], preset["chip.video"], preset["chip.paste"]])
    .map((icon) => icon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")}) #[1-9]\\d*`,
);

// Copied from pi-tui's prompt/image-format.ts, which compiled OMP does not serve to extensions
// either. Stored images keep the display extensions OMP gives them.
const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

function normalizeBlobExtension(extension: string | undefined): string | undefined {
  if (!extension) return undefined;
  const normalized = extension.startsWith(".") ? extension.slice(1) : extension;
  if (normalized.length === 0 || normalized.length > 32) return undefined;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized)) return undefined;
  return normalized.toLowerCase();
}

function blobExtensionForImageMimeType(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  const lower = mimeType.toLowerCase();
  const known = IMAGE_EXTENSION_BY_MIME[lower];
  if (known) return known;
  if (!lower.startsWith("image/")) return undefined;
  const subtype = lower.slice("image/".length).split(";")[0]?.split("+")[0];
  return normalizeBlobExtension(subtype);
}

type ComposerDraft = { draft: EditorDraft; images: ImageContent[] };

// Reads the composer without touching storage: the draft, with image markers numbered densely, and
// the images those markers still reference.
function readComposerDraft(ctx: ExtensionContext): ComposerDraft {
  const editor = activeEditor(ctx);
  if (!editor) {
    const draft = parseEditorDraft(ctx.ui.getEditorText());
    if (ATTACHMENT_TOKEN.test(draft.text) || COLLAPSED_PASTE_TOKEN.test(draft.text)) {
      throw new Error("Restart OMP once so OhMyStash can attach to the native editor");
    }
    return { draft, images: [] };
  }
  // Deleted chips leave their images in pendingImages. Like OMP's submit, keep only images the
  // text still references and renumber their markers densely.
  const expanded = editor.getExpandedText();
  const keep = [...new Set(Array.from(expanded.matchAll(VISION_MARKER), (match) => Number(match[2])))]
    .filter((n) => n <= editor.pendingImages.length)
    .sort((a, b) => a - b);
  const draft = parseEditorDraft(
    expanded.replace(VISION_MARKER, (marker, kind: string, n: string, tail: string, ref: string | undefined) => {
      const index = keep.indexOf(Number(n)) + 1;
      if (index === 0) return marker;
      return `[${kind} #${index}${tail}]${ref === undefined ? "" : ` attachment://${index}`}`;
    }),
  );
  const images = editor.pendingImages.filter((_, index) => keep.includes(index + 1));
  if (images.length > MAX_ATTACHMENTS) {
    throw new Error(`An OMS entry can contain at most ${MAX_ATTACHMENTS} attachments`);
  }
  return { draft, images };
}

function persistDraftAttachments({ draft: expandedDraft, images }: ComposerDraft): CapturedDraft {
  let attachmentBytes = 0;
  const attachments: StoredAttachment[] = [];
  // A draft can repeat one image many times; its bytes are checked and stored once.
  const stored = new Map<string, string>();
  for (const image of images) {
    const data = Buffer.from(image.data, "base64");
    attachmentBytes += data.byteLength;
    if (attachmentBytes > MAX_ENTRY_ATTACHMENT_BYTES) {
      throw new Error("OMS attachments exceed the 128 MiB per-entry limit");
    }
    const extension = blobExtensionForImageMimeType(image.mimeType);
    const key = `${extension ?? ""}:${image.data}`;
    let ref = stored.get(key);
    if (ref === undefined) {
      ref = persistAsset(data, extension);
      stored.set(key, ref);
    }
    attachments.push({
      kind: "image",
      ref,
      byteLength: data.byteLength,
      mimeType: image.mimeType,
      ...(image.detail === undefined ? {} : { detail: image.detail }),
    });
  }
  const textBytes = Buffer.byteLength(expandedDraft.text, "utf8");
  if (textBytes <= MAX_PROMPT_BYTES) {
    return { ...expandedDraft, attachments };
  }
  attachmentBytes += textBytes;
  if (textBytes > MAX_ATTACHMENT_BYTES || attachmentBytes > MAX_ENTRY_ATTACHMENT_BYTES) {
    throw new Error("Large pasted prompt exceeds the 64 MiB text attachment limit");
  }
  if (attachments.length >= MAX_ATTACHMENTS) {
    throw new Error(`An OMS entry can contain at most ${MAX_ATTACHMENTS} attachments`);
  }
  const ref = persistAsset(Buffer.from(expandedDraft.text, "utf8"), "txt");
  attachments.push({
    kind: "body",
    ref,
    byteLength: textBytes,
    charCount: expandedDraft.text.length,
    lineCount: promptLineCount(expandedDraft.text),
  });
  return {
    inputMode: expandedDraft.inputMode,
    text: `[Large pasted prompt · ${promptLineCount(expandedDraft.text)} lines · ${expandedDraft.text.length} chars]`,
    attachments,
  };
}

type AttachmentFailure = { label: string; reason: string };
type ResolvedAttachments = {
  body?: string;
  images: ImageContent[];
  imageLinks: string[];
  // The 1-based numbers, among the stash's images, of the images that loaded.
  imageNumbers: number[];
  imageCount: number;
  failures: AttachmentFailure[];
};

// Reads every attachment it can. One that fails its checks is reported instead of failing the
// whole restore.
function resolveStoredAttachments(entry: StashEntry): ResolvedAttachments {
  let body: string | undefined;
  const images: ImageContent[] = [];
  const imageLinks: string[] = [];
  const imageNumbers: number[] = [];
  const failures: AttachmentFailure[] = [];
  let imageCount = 0;
  for (const attachment of entry.attachments) {
    if (attachment.kind === "image") imageCount += 1;
    let data: Buffer;
    try {
      data = readAsset(attachment.ref, attachment.byteLength);
    } catch (error) {
      failures.push({
        label: attachment.kind === "image" ? `Image #${imageCount}` : "the large pasted text",
        reason: error instanceof AttachmentCheckError
          ? error.reason
          : errorCode(error) === "ENOENT" ? "missing" : error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (attachment.kind === "image") {
      images.push({
        type: "image", data: data.toString("base64"), mimeType: attachment.mimeType,
        ...(attachment.detail === undefined ? {} : { detail: attachment.detail }),
      });
      imageLinks.push(pathToFileURL(attachmentDisplayPath(attachment)).href);
      imageNumbers.push(imageCount);
    } else {
      if (body !== undefined) throw new Error("OMS entry contains multiple large text bodies");
      body = data.toString("utf8");
    }
  }
  return { body, images, imageLinks, imageNumbers, imageCount, failures };
}

// Renumbers the image markers to the images that loaded. The marker of an image that couldn't be
// read becomes plain text, so it can't pick up another image.
function renumberImageMarkers(text: string, imageNumbers: number[], imageCount: number): string {
  if (imageNumbers.length === imageCount) return text;
  return text.replace(VISION_MARKER, (marker, kind: string, n: string, tail: string, ref: string | undefined) => {
    const number = Number(n);
    if (number > imageCount) return marker;
    const index = imageNumbers.indexOf(number) + 1;
    if (index === 0) return `[${kind} #${number} unavailable]`;
    return `[${kind} #${index}${tail}]${ref === undefined ? "" : ` attachment://${index}`}`;
  });
}

// Names the attachments a restore left out, grouped by why.
function describeFailures(failures: AttachmentFailure[]): string {
  const byReason = new Map<string, string[]>();
  for (const { label, reason } of failures) byReason.set(reason, [...(byReason.get(reason) ?? []), label]);
  return [...byReason].map(([reason, labels]) => `${labels.join(", ")} (${reason})`).join("; ");
}

// Puts a stash into the composer and returns the attachments that couldn't be read; the rest of the
// draft comes back without them. With `links` off, OMP makes the image links itself, for a stash
// that's about to be deleted.
function restoreIntoComposer(
  ctx: ExtensionContext,
  entry: StashEntry,
  options: { forceQueue?: boolean; links?: boolean } = {},
): AttachmentFailure[] {
  const prefix = options.forceQueue || entry.inputMode === "queue" ? "/queue " : "";
  const editor = activeEditor(ctx);
  if (!editor) {
    if (entry.attachments.length > 0) {
      throw new Error("Restart OMP once so OhMyStash can restore native attachments");
    }
    ctx.ui.setEditorText(`${prefix}${entry.text}`);
    return [];
  }
  const resolved = entry.attachments.length === 0 ? undefined : inStore(false, () => resolveStoredAttachments(entry));
  const images = resolved?.images ?? [];
  const text = resolved
    ? renumberImageMarkers(resolved.body ?? entry.text, resolved.imageNumbers, resolved.imageCount)
    : entry.text;
  const links = options.links === false ? undefined : resolved?.imageLinks ?? [];
  if (text.length > 1_000 || text.includes("\n")) {
    editor.setDraft(prefix, images);
    if (links) {
      editor.pendingImageLinks = links;
      editor.imageLinks = links;
    }
    // Restore saved content synchronously; terminal paste can open an async menu.
    editor.insertPaste(text);
  } else {
    editor.setDraft(`${prefix}${text}`, images);
    if (links) {
      editor.pendingImageLinks = links;
      editor.imageLinks = links;
    }
  }
  editor.tui?.requestRender();
  return resolved?.failures ?? [];
}

// Submits a stash as a /queue message. If an attachment couldn't be read, it stops at the draft
// instead, so a partial prompt never goes out unseen.
function submitQueuedEntry(ctx: ExtensionContext, entry: StashEntry): "submitted" | "drafted" | "blocked" {
  const editor = activeEditor(ctx);
  if (!editor) {
    throw new Error("Restart OMP once so OhMyStash can submit queued stashes");
  }
  if (hasEditorContent(ctx)) {
    ctx.ui.notify("Stash or clear the current editor before submitting a queued stash", "warning");
    return "blocked";
  }
  const failures = restoreIntoComposer(ctx, entry, { forceQueue: true });
  markEntryUsed(entry);
  if (failures.length > 0) {
    ctx.ui.notify(
      `Inserted the queued draft without submitting it, because it's missing ${describeFailures(failures)}. The stash file is unchanged`,
      "warning",
    );
    return "drafted";
  }
  // Enter follows user keybindings and may insert a newline instead of submitting.
  editor.submit();
  return "submitted";
}

function editableEntryText(entry: StashEntry): string {
  const body = entry.attachments.find(
    (attachment): attachment is StoredTextAttachment => attachment.kind === "body",
  );
  return body ? inStore(false, () => readAsset(body.ref, body.byteLength).toString("utf8")) : entry.text;
}

// Opens a stash in the configured editor and returns the edited text. Saving it is a separate
// storage step.
async function editEntryText(
  ctx: ExtensionContext,
  entry: StashEntry,
  tui: TUI,
): Promise<{ text: string } | "unchanged" | "cancelled"> {
  const original = editableEntryText(entry);
  const editorCommand = pluginConfig.editorCommand || getEditorCommand();
  let edited: string | null | undefined;
  if (editorCommand) {
    tui.stop();
    try {
      // Editors such as vim, nano, and helix end every saved file with a newline. Keep it only when
      // the stash already ended with one, so quitting without changes leaves the stash untouched.
      edited = await openInEditor(editorCommand, original, {
        extension: ".md",
        trimTrailingNewline: !original.endsWith("\n"),
      });
    } finally {
      tui.start();
      tui.requestRender(true);
    }
  } else {
    edited = await ctx.ui.editor(
      "Edit stashed prompt",
      original,
      undefined,
      { promptStyle: false },
    );
  }
  if (edited === null || edited === undefined) return "cancelled";
  if (edited === original) return "unchanged";
  return { text: edited };
}

function clearEditorAfterStash(ctx: ExtensionContext, inputMode: InputMode): void {
  const editor = activeEditor(ctx);
  if (editor) {
    editor.setDraft(inputMode === "queue" ? "/queue " : "");
    editor.tui?.requestRender();
  } else {
    ctx.ui.setEditorText(inputMode === "queue" ? "/queue " : "");
  }
}


function compactAge(stashedAtMs: number, now: number): string {
  const elapsed = Math.max(0, now - stashedAtMs);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  return COMPACT_DATE_FORMATTER.format(stashedAtMs);
}

function filterStashEntries(
  entries: StashEntry[],
  query: string,
  includeOrigin = false,
): StashEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return entries;
  const literalMatches = entries.filter((entry) => {
    if (includeOrigin) {
      entry.searchTextAllLower ??= entry.searchTextAll.toLowerCase();
      return entry.searchTextAllLower.includes(normalized);
    }
    entry.searchTextLower ??= entry.searchText.toLowerCase();
    return entry.searchTextLower.includes(normalized);
  });
  // Literal search reads whole prompts. The typo-tolerant fallback reads only the first and last
  // 2,048 characters of long entries, so pi-tui can cache their search indexes between keystrokes.
  return literalMatches.length > 0
    ? literalMatches
    : fuzzyFilter(entries, query, (entry) => {
        const text = includeOrigin ? entry.searchTextAll : entry.searchText;
        return text.length <= 4096 ? text : `${text.slice(0, 2048)}\n${text.slice(-2047)}`;
      });
}

function showBrowser(
  ctx: ExtensionContext,
  entries: StashEntry[],
  initial: BrowserState,
): Promise<BrowserAction> {
  return ctx.ui.custom<BrowserAction>(
    (tui, theme, _keybindings, done) => {
      const searchInput = new Input();
      searchInput.prompt = "/";
      searchInput.setValue(initial.query);
      const currentSessionId = ctx.sessionManager.getSessionId();
      const currentEntries = entries.filter((entry) => isCurrentChat(entry, currentSessionId));
      let scope = initial.scope;
      let scopedEntries = scope === "current" ? currentEntries : entries;
      let searching = false;
      let filteredEntries = filterStashEntries(
        scopedEntries,
        initial.query,
        scope === "all",
      );
      // Reopening after an action selects the same stash, or the row it was on when it's gone.
      const reselected = filteredEntries.findIndex((entry) => entry.id === initial.selectedId);
      let selected = reselected !== -1
        ? reselected
        : Math.max(0, Math.min(initial.selectedIndex, filteredEntries.length - 1));
      let previewOffset = 0;
      let previewRows = 1;
      let previewCache: { entry: StashEntry; width: number; model: PreviewModel } | undefined;

      const selectedEntry = () => filteredEntries[selected];
      const applySearch = () => {
        filteredEntries = filterStashEntries(
          scopedEntries,
          searchInput.getValue(),
          scope === "all",
        );
        selected = 0;
        previewOffset = 0;
        tui.requestRender();
      };
      const toggleScope = () => {
        scope = scope === "current" ? "all" : "current";
        scopedEntries = scope === "current" ? currentEntries : entries;
        applySearch();
      };
      const moveSelection = (delta: number) => {
        if (filteredEntries.length === 0) return;
        selected = Math.max(0, Math.min(filteredEntries.length - 1, selected + delta));
        previewOffset = 0;
        tui.requestRender();
      };
      const previewModel = (width: number) => {
        const entry = selectedEntry();
        if (!entry) return undefined;
        // Rebuild only when the selection or width changes, not on every search keystroke.
        if (previewCache?.entry !== entry || previewCache.width !== width) {
          previewCache = { entry, width, model: buildPreviewModel(entry.text, width) };
        }
        return previewCache.model;
      };
      const exitSearch = (clear: boolean) => {
        searching = false;
        searchInput.focused = false;
        if (clear) {
          searchInput.setValue("");
          applySearch();
        } else {
          tui.requestRender();
        }
      };
      const browserState = (): BrowserState => ({
        query: searchInput.getValue(),
        scope,
        selectedId: selectedEntry()?.id,
        selectedIndex: selected,
      });
      const finishSelected = (type: "restore" | "pop" | "queue" | "submit-queue") => {
        const entry = selectedEntry();
        if (entry) done({ type, entry, ...browserState() });
      };

      const finishDelete = () => {
        const entry = selectedEntry();
        if (entry) done({ type: "delete", entry, ...browserState() });
      };
      const finishDeleteAll = () => {
        if (scopedEntries.length > 0) {
          done({ type: "delete-all", entries: [...scopedEntries], ...browserState() });
        }
      };
      const finishToggleLock = () => {
        const entry = selectedEntry();
        if (entry) done({ type: "toggle-lock", entry, ...browserState() });
      };
      const finishEdit = () => {
        const entry = selectedEntry();
        if (entry) done({ type: "edit", entry, ...browserState(), tui });
      };
      return {
        invalidate() {
          previewCache = undefined;
          searchInput.invalidate();
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.ctrl("c"))) {
            done(null);
            return;
          }
          // While searching, every printable key, q and Q included, types into the search. The
          // letter actions work after Tab.
          if (searching) {
            if (matchesKey(data, Key.escape)) {
              exitSearch(true);
            } else if (matchesKey(data, Key.enter)) {
              finishSelected("restore");
            } else if (matchesKey(data, Key.tab)) {
              exitSearch(false);
            } else if (matchesKey(data, Key.up)) {
              moveSelection(-1);
            } else if (matchesKey(data, Key.down)) {
              moveSelection(1);
            } else {
              const before = searchInput.getValue();
              searchInput.handleInput(data);
              if (searchInput.getValue() !== before) applySearch();
              else tui.requestRender();
            }
            return;
          }
          // Kitty's CSI-u forms of letter keys mean the same as the plain characters.
          const key = extractPrintableText(data);
          if (key === "/") {
            searching = true;
            searchInput.focused = true;
            tui.requestRender();
          } else if (key === "g") {
            toggleScope();
          } else if (matchesKey(data, Key.escape)) {
            if (searchInput.getValue()) exitSearch(true);
            else done(null);
          } else if (matchesKey(data, Key.up)) {
            moveSelection(-1);
          } else if (matchesKey(data, Key.down)) {
            moveSelection(1);
          } else if (matchesKey(data, Key.home)) {
            moveSelection(-filteredEntries.length);
          } else if (matchesKey(data, Key.end)) {
            moveSelection(filteredEntries.length);
          } else if (matchesKey(data, Key.pageUp) || key === "[") {
            previewOffset = Math.max(0, previewOffset - previewRows);
            tui.requestRender();
          } else if (matchesKey(data, Key.pageDown) || key === "]") {
            previewOffset += previewRows;
            tui.requestRender();
          } else if (matchesKey(data, Key.enter) || key === "r") {
            finishSelected("restore");
          } else if (key === "p") {
            finishSelected("pop");
          } else if (key === "q") {
            finishSelected("queue");
          } else if (key === "Q") {
            finishSelected("submit-queue");
          } else if (key === "e") {
            finishEdit();
          } else if (key === "l") {
            finishToggleLock();
          } else if (key === "d" || matchesKey(data, Key.delete)) {
            finishDelete();
          } else if (key === "D") {
            finishDeleteAll();
          }
        },
        render(width: number) {
          // The overlay may fill the terminal; OMP drops taller output from the top, title first.
          const terminalRows = Math.max(1, tui.terminal.rows);
          const renderWidth = Math.max(1, width);
          const activeScopeLabel = scope === "current" ? "This chat" : "All chats";
          const entry = selectedEntry();
          const query = searchInput.getValue();
          const emptyCurrent =
            scope === "current" && currentEntries.length === 0 && !query && !searching;
          const showOrigin = scope === "all" && entry !== undefined;
          const renderNow = Date.now();
          const border = (text: string) => theme.fg("accent", text);
          const outerWidth = Math.max(1, renderWidth - 2);
          const searchIcon = theme.fg(
            "accent",
            pluginConfig.showIcons ? extensionIcon("icon.search") : "/",
          );
          const stashGlyph = pluginConfig.showIcons ? extensionIcon("icon.cache") : "";
          const draftGlyph = pluginConfig.showIcons ? extensionIcon("icon.file") : "[D]";
          const savedGlyph = pluginConfig.showIcons ? extensionIcon("icon.folder") : "";
          const queueGlyph = pluginConfig.showIcons ? extensionIcon("icon.output") : "[Q]";
          const timeGlyph = pluginConfig.showIcons ? extensionIcon("icon.time") : "";
          const labelWithIcon = (glyph: string, label: string) =>
            glyph ? `${glyph} ${label}` : label;
          const keyHint = (key: string, label: string) =>
            `${theme.fg("accent", key)} ${theme.fg("dim", label)}`;
          // Letter actions only work outside the search field, so searching shows just Enter.
          const promptFooter = entry
            ? (searching
                ? [keyHint("Enter", "Restore")]
                : [
                    keyHint("Enter", "Restore"),
                    keyHint("q", "Draft"),
                    keyHint("Q", "Queue"),
                    keyHint("l", entry.locked ? "Unlock" : "Lock"),
                    keyHint("d", "Delete"),
                    keyHint("e", "Edit"),
                    keyHint("p", "Pop"),
                  ]
              ).join(theme.fg("dim", " "))
            : "";
          const browserFooter = (searching
            ? [
                keyHint("Tab", "Select"),
                keyHint("Esc", "Clear"),
                keyHint("↑↓", "Navigate"),
              ]
            : [
                keyHint("/", "Search"),
                keyHint(
                  "g",
                  renderWidth >= 100
                    ? scope === "current"
                      ? "Global"
                      : "Current"
                    : "Scope",
                ),
                keyHint("↑↓", "Move"),
                keyHint("D", "Clear"),
                keyHint("[]", "Scroll"),
                keyHint("Esc", query ? "Clear" : "Close"),
              ]
          ).join(theme.fg("dim", " "));
          const renderSearchBar = (contentWidth: number): string => {
            if (!query && !searching) return "";
            const count = `${filteredEntries.length}/${scopedEntries.length} matches`;
            const prefix = ` ${searchIcon} `;
            const suffix = ` ${theme.fg("dim", count)} `;
            const fieldWidth = Math.max(
              1,
              contentWidth - visibleWidth(prefix) - visibleWidth(suffix),
            );
            const field = searching
              ? searchInput.render(fieldWidth)[0] ?? "/"
              : theme.fg("text", `/${query}`);
            const clipped = truncateToWidth(field, fieldWidth);
            return `${prefix}${clipped}${" ".repeat(Math.max(0, fieldWidth - visibleWidth(clipped)))}${suffix}`;
          };
          const ruleCell = (label: string, cellWidth: number): string => {
            const text = ` ${label} `;
            const heading = theme.fg(
              "accent",
              theme.bold(truncateToWidth(text, cellWidth, "")),
            );
            const rule = theme.fg(
              "muted",
              "─".repeat(Math.max(0, cellWidth - visibleWidth(text))),
            );
            return `${heading}${rule}`;
          };
          const listRow = (item: StashEntry, index: number, cellWidth: number): string => {
            const isSelected = index === selected;
            const cursor = isSelected ? theme.fg("accent", ">") : " ";
            const mode = theme.fg(item.inputMode === "queue" ? "accent" : "muted", item.inputMode === "queue" ? queueGlyph : draftGlyph);
            const lock = item.locked ? theme.fg("warning", "[L]") : "";
            const conflict = item.preserved ? theme.fg("warning", "[C]") : "";
            const attachmentCount =
              item.attachments.length > 0 ? theme.fg("muted", `+${item.attachments.length}`) : "";
            const age = theme.fg("dim", compactAge(item.stashedAtMs, renderNow));
            const prefix = ` ${cursor} ${mode}${lock ? ` ${lock}` : ""}${conflict ? ` ${conflict}` : ""}${attachmentCount ? ` ${attachmentCount}` : ""} `;
            const originWidth =
              scope === "all" ? Math.min(18, Math.max(8, Math.floor(cellWidth * 0.28))) : 0;
            const origin =
              originWidth > 0
                ? theme.fg("dim", truncateToWidth(item.displayOrigin, originWidth))
                : "";
            const suffix = `${origin ? `${origin} ` : ""}${age}`;
            const available = Math.max(
              1,
              cellWidth - visibleWidth(prefix) - visibleWidth(suffix) - 1,
            );
            const summary = truncateToWidth(item.displayHeadline, available);
            const styled = isSelected ? theme.fg("accent", theme.bold(summary)) : summary;
            const gap = " ".repeat(
              Math.max(
                1,
                cellWidth - visibleWidth(prefix) - visibleWidth(summary) - visibleWidth(suffix),
              ),
            );
            return `${prefix}${styled}${gap}${suffix}`;
          };

          const useSplitLayout =
            (pluginConfig.layout === "split" && renderWidth >= 72) ||
            (pluginConfig.layout === "auto" && renderWidth >= 92);
          // Framed layouts need their tallest chrome (prompt actions, plus origin details when
          // stacked) and a minimal body: split 8 + 4 rows, stacked 10 + 3. Otherwise go compact,
          // which fits any terminalRows, so the title and search row are never clipped.
          if (
            pluginConfig.layout === "compact" ||
            renderWidth < 32 ||
            terminalRows < (useSplitLayout ? 12 : 13)
          ) {
            const position = entry ? `${selected + 1}/${filteredEntries.length}` : `0/${filteredEntries.length}`;
            const mode = entry
              ? ` · ${entry.inputMode === "queue" ? queueGlyph : draftGlyph}${entry.locked ? " [L]" : ""}${entry.preserved ? " [C]" : ""}${entry.attachments.length > 0 ? ` +${entry.attachments.length}` : ""}`
              : "";
            const scopeLabel =
              scope === "current" ? "This chat" : (entry?.displayOrigin ?? "All chats");
            const header = truncateToWidth(
              searching
                ? searchInput.render(renderWidth)[0] ?? "/"
                : `Stash ${position} · ${scopeLabel}${mode}`,
              renderWidth,
              "",
            );
            const searchLine =
              searching || query
                ? `${searchIcon} ${query ? `/${query}` : "/"}`
                : `${searchIcon} / search · g ${scope === "current" ? "all chats" : "this chat"}`;
            if (!entry) {
              const noCurrentStashes = emptyCurrent;
              return [
                theme.fg("accent", header),
                truncateToWidth(searchLine, renderWidth, ""),
                theme.fg(
                  "muted",
                  truncateToWidth(
                    noCurrentStashes ? "No stashes in this chat" : "No matching prompts",
                    renderWidth,
                    "",
                  ),
                ),
                ...(noCurrentStashes && entries.length > 0
                  ? [theme.fg("dim", truncateToWidth(`${entries.length} elsewhere · press g`, renderWidth, ""))]
                  : []),
              ].slice(0, terminalRows);
            }
            const visiblePreviewRows = Math.max(0, terminalRows - 2);
            previewRows = Math.max(1, visiblePreviewRows);
            const model = previewModel(renderWidth)!;
            const maxPreviewOffset = Math.max(0, model.totalRows - previewRows);
            previewOffset = Math.min(previewOffset, maxPreviewOffset);
            const page = previewPage(model, previewOffset, visiblePreviewRows);
            return [
              theme.fg("accent", header),
              truncateToWidth(searchLine, renderWidth, ""),
              ...page.map((line) => truncateToWidth(line, renderWidth, "")),
            ].slice(0, terminalRows);
          }

          const frame = createFrame(theme, renderWidth);
          if (useSplitLayout) {
            const promptFooterRows = entry ? 2 : 0;
            const availableBodyRows = Math.min(
              Math.max(4, pluginConfig.maxBodyRows - promptFooterRows),
              Math.max(4, terminalRows - 6 - promptFooterRows),
            );
            const leftWidth = Math.min(44, Math.max(32, Math.floor((renderWidth - 3) * 0.38)));
            const rightWidth = Math.max(1, renderWidth - 3 - leftWidth);
            const leftContentWidth = Math.max(1, leftWidth - 1);
            const rightContentWidth = Math.max(1, rightWidth - 1);
            const model = entry ? previewModel(rightContentWidth)! : undefined;
            const desiredListRows = Math.min(12, Math.max(4, filteredEntries.length));
            const desiredPreviewRows = model
              ? Math.min(pluginConfig.maxBodyRows, Math.max(4, model.totalRows + 2))
              : 4;
            const bodyRows = Math.min(availableBodyRows, Math.max(desiredListRows, desiredPreviewRows));
            previewRows = Math.max(1, bodyRows - 2);
            if (model) {
              previewOffset = Math.min(previewOffset, Math.max(0, model.totalRows - previewRows));
            } else {
              previewOffset = 0;
            }
            const previewEnd = model ? Math.min(model.totalRows, previewOffset + previewRows) : 0;
            const page = model ? previewPage(model, previewOffset, previewRows) : [];
            const firstListIndex = Math.min(
              Math.max(0, selected - Math.floor(bodyRows / 2)),
              Math.max(0, filteredEntries.length - bodyRows),
            );
            const position = entry ? `${selected + 1} of ${filteredEntries.length}` : `0 of ${filteredEntries.length}`;
            const previewLabel = labelWithIcon(
              entry?.inputMode === "queue" ? queueGlyph : draftGlyph,
              `Preview · ${entry?.inputMode === "queue" ? "Queue draft" : "Prompt draft"}`,
            );
            const lines = [
              frame.top(labelWithIcon(stashGlyph, "OhMyStash")),
              frame.row(renderSearchBar(outerWidth)),
              `${border("├")}${ruleCell(labelWithIcon(savedGlyph, `${activeScopeLabel} · ${position}`), leftWidth)}${border("┬")}${ruleCell(
                previewLabel,
                rightWidth,
              )}${border("┤")}`,
            ];
            for (let row = 0; row < bodyRows; row += 1) {
              const index = firstListIndex + row;
              const item = filteredEntries[index];
              const left = item
                ? listRow(item, index, leftContentWidth)
                : row === 0 && !entry
                  ? theme.fg(
                      "muted",
                      emptyCurrent ? "No stashes in this chat" : "No prompts match this search",
                    )
                  : "";
              let right = "";
              if (entry && model) {
                if (row === 0) {
                  const lineLabel = entry.lineCount === 1 ? "1 line" : `${entry.lineCount} lines`;
                  right = theme.fg(
                    "muted",
                    `${labelWithIcon(timeGlyph, entry.displayTimestamp)} · ${lineLabel} · ${entry.text.length} chars · ${entry.attachments.length} attachments${entry.locked ? " · locked" : ""}${entry.preserved ? " · conflict copy" : ""} · rows ${previewOffset + 1}-${previewEnd}/${model.totalRows}`,
                  );
                } else if (row === 1 && showOrigin) {
                  right = theme.fg("dim", stashOriginDetails(entry.origin));
                } else if (row > 1) {
                  right = page[row - 2] ?? "";
                }
              } else if (row === 0) {
                right = theme.fg(
                  "muted",
                  emptyCurrent && entries.length > 0
                    ? `${entries.length} stashes available in other chats`
                    : "No prompt selected",
                );
              } else if (row === 1) {
                right = theme.fg(
                  "dim",
                  emptyCurrent ? "Press g to view all chats" : "Adjust or clear the search to continue",
                );
              }
              lines.push(
                `${border("│")}${fitToWidth(` ${left}`, leftWidth)}${border("│")}${fitToWidth(` ${right}`, rightWidth)}${border("│")}`,
              );
            }
            if (entry) {
              lines.push(
                border(`├${"─".repeat(leftWidth)}┼${"─".repeat(rightWidth)}┤`),
                `${border("│")}${fitToWidth("", leftWidth)}${border("│")}${fitToWidth(` ${promptFooter}`, rightWidth)}${border("│")}`,
              );
            }
            lines.push(
              border(`├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`),
              frame.row(` ${browserFooter}`),
              frame.bottom(),
            );
            return lines;
          }

          const promptFooterRows = entry ? 2 : 0;
          const availableBodyBudget = Math.min(
            Math.max(3, pluginConfig.maxBodyRows - promptFooterRows),
            Math.max(3, terminalRows - (showOrigin ? 8 : 7) - promptFooterRows),
          );
          const contentWidth = Math.max(1, outerWidth - 1);
          const model = entry ? previewModel(contentWidth)! : undefined;
          const desiredListRows = Math.min(6, Math.max(2, filteredEntries.length));
          const desiredPreviewRows = model ? Math.min(10, Math.max(3, model.totalRows)) : 3;
          const bodyBudget = Math.min(availableBodyBudget, desiredListRows + desiredPreviewRows);
          const listRows = Math.min(desiredListRows, Math.max(2, bodyBudget - 1));
          previewRows = Math.max(1, bodyBudget - listRows);
          if (model) {
            previewOffset = Math.min(previewOffset, Math.max(0, model.totalRows - previewRows));
          } else {
            previewOffset = 0;
          }
          const previewEnd = model ? Math.min(model.totalRows, previewOffset + previewRows) : 0;
          const page = model ? previewPage(model, previewOffset, previewRows) : [];
          const firstListIndex = Math.min(
            Math.max(0, selected - Math.floor(listRows / 2)),
            Math.max(0, filteredEntries.length - listRows),
          );
          const position = entry ? `${selected + 1} of ${filteredEntries.length}` : `0 of ${filteredEntries.length}`;
          const previewLabel = labelWithIcon(
            entry?.inputMode === "queue" ? queueGlyph : draftGlyph,
            `Preview · ${entry?.inputMode === "queue" ? "Queue draft" : "Prompt draft"}`,
          );
          const lines = [
            frame.top(labelWithIcon(stashGlyph, "OhMyStash")),
            frame.row(renderSearchBar(outerWidth)),
            frame.divider(labelWithIcon(savedGlyph, `${activeScopeLabel} · ${position}`)),
          ];
          for (let row = 0; row < listRows; row += 1) {
            const index = firstListIndex + row;
            const item = filteredEntries[index];
            lines.push(
              frame.row(
                item
                  ? listRow(item, index, outerWidth)
                  : row === 0 && !entry
                    ? theme.fg(
                        "muted",
                        emptyCurrent ? "No stashes in this chat" : "No prompts match this search",
                      )
                    : "",
              ),
            );
          }
          lines.push(
            frame.divider(previewLabel),
            frame.row(
              entry && model
                ? theme.fg(
                    "muted",
                    ` ${labelWithIcon(timeGlyph, entry.displayTimestamp)} · ${entry.lineCount === 1 ? "1 line" : `${entry.lineCount} lines`} · ${entry.text.length} chars · ${entry.attachments.length} attachments${entry.locked ? " · locked" : ""}${entry.preserved ? " · conflict copy" : ""} · rows ${previewOffset + 1}-${previewEnd}/${model.totalRows}`,
                  )
                : theme.fg(
                    "muted",
                    emptyCurrent && entries.length > 0
                      ? ` ${entries.length} stashes available in other chats · press g`
                      : " Adjust or clear the search",
                  ),
            ),
          );
          if (showOrigin) {
            lines.push(frame.row(` ${theme.fg("dim", stashOriginDetails(entry.origin))}`));
          }
          for (let row = 0; row < previewRows; row += 1) {
            lines.push(frame.row(` ${page[row] ?? ""}`));
          }
          if (entry) {
            lines.push(
              frame.divider(),
              frame.row(` ${promptFooter}`),
            );
          }
          lines.push(frame.row(` ${browserFooter}`), frame.bottom());
          return lines;
        },
      };
    },
    OVERLAY_OPTIONS,
  );
}

// Runs a step that only reads in one storage scope. A store that doesn't exist yet reads as empty.
function readStore<T>(step: () => T): T {
  return existsSync(stashDir()) ? inStore(false, step) : step();
}

function loadEntriesForUi(ctx: ExtensionContext): StashEntry[] {
  const { entries, omitted } = loadEntries();
  const dir = stashDir();
  const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
  const warn = (count: number, message: string) => {
    if (count > 0) ctx.ui.notify(message, "warning");
  };
  const { permissions, damaged, unsupported, overLimit } = omitted;
  warn(
    permissions,
    `${permissions} OMS ${plural(permissions, "stash is", "stashes are")} hidden because ${plural(permissions, "its file is", "their files are")} shared with other accounts. ${privateFileFix(dir, "/*.json")}`,
  );
  warn(
    damaged,
    `${damaged} damaged OMS stash ${plural(damaged, "file was", "files were")} set aside in ${dir} with an .invalid or .orphan suffix`,
  );
  warn(
    unsupported,
    `${unsupported} OMS stash ${plural(unsupported, "file", "files")} in ${dir} couldn't be loaded. ${plural(unsupported, "It", "They")} may come from a newer OhMyStash`,
  );
  warn(
    overLimit,
    `${overLimit} older OMS ${plural(overLimit, "stash is", "stashes are")} hidden because the store is over its limit of ${MAX_ENTRY_FILES} stashes or 16 MiB. Delete stashes you don't need to bring ${plural(overLimit, "it", "them")} back`,
  );
  return entries;
}

// Reports a restore, naming the attachments it had to leave out.
function notifyRestored(ctx: ExtensionContext, summary: string, failures: AttachmentFailure[], detail: string): void {
  if (failures.length === 0) ctx.ui.notify(`${summary}; ${detail}`, "info");
  else ctx.ui.notify(`${summary}, but couldn't restore ${describeFailures(failures)}`, "warning");
}

async function stashCurrent(ctx: ExtensionContext): Promise<void> {
  const composer = readComposerDraft(ctx);
  if (composer.draft.text.length === 0 && composer.images.length === 0) {
    ctx.ui.notify("Nothing to stash", "info");
    return;
  }
  const origin = currentStashOrigin(ctx);
  const fileBacked = composer.images.length > 0 || Buffer.byteLength(composer.draft.text, "utf8") > MAX_PROMPT_BYTES;
  const { draft, repeated } = inStore(true, () => {
    const captured: CapturedDraft = fileBacked ? persistDraftAttachments(composer) : { ...composer.draft, attachments: [] };
    // Stashing what this chat's newest stash already holds, for example after restoring it,
    // updates that stash instead of adding a copy.
    let newest: StashEntry | undefined;
    try {
      newest = loadEntries().entries.find((entry) => isCurrentChat(entry, origin.sessionId));
    } catch {}
    if (
      newest && !newest.preserved && !STALE_TEMP.test(newest.fileName) &&
      newest.text === captured.text && newest.inputMode === captured.inputMode &&
      JSON.stringify(newest.attachments) === JSON.stringify(captured.attachments)
    ) {
      try {
        replaceEntry(newest, newest.text, newest.attachments, newest.locked, new Date().toISOString());
        return { draft: captured, repeated: true };
      } catch (error) {
        if (!(error instanceof EntryConflictError)) throw error;
      }
    }
    saveEntry(captured.text, captured.inputMode, captured.attachments, origin);
    return { draft: captured, repeated: false };
  }, fileBacked);
  clearEditorAfterStash(ctx, draft.inputMode);
  const label = draft.inputMode === "queue" ? "Queue prompt" : "Prompt";
  if (repeated) {
    ctx.ui.notify(`${label} was already this chat's latest stash, so OMS kept that one`, "info");
    return;
  }
  const attachmentLabel =
    draft.attachments.length > 0
      ? ` with ${draft.attachments.length} ${draft.attachments.length === 1 ? "attachment" : "attachments"}`
      : "";
  ctx.ui.notify(
    `${label} stashed (${promptLineCount(draft.text)} lines${attachmentLabel})`,
    "info",
  );
}

async function restoreLatest(ctx: ExtensionContext, requestedMode?: InputMode): Promise<void> {
  if (!isMainTui(ctx)) return;
  const current = parseEditorDraft(ctx.ui.getEditorText());
  if (hasEditorContent(ctx)) {
    ctx.ui.notify("Stash or clear the current editor before restoring a prompt", "warning");
    return;
  }
  const mode = requestedMode ?? (current.inputMode === "queue" ? "queue" : undefined);
  const restored = readStore(() => {
    const entries = loadEntriesForUi(ctx);
    const currentSessionId = ctx.sessionManager.getSessionId();
    const currentEntries = entries.filter((candidate) => isCurrentChat(candidate, currentSessionId));
    const entry = mode
      ? currentEntries.find((candidate) => candidate.inputMode === mode)
      : currentEntries[0];
    if (!entry) return { entries };
    const failures = restoreIntoComposer(ctx, entry);
    markEntryUsed(entry);
    return { entries, entry, failures };
  });
  const { entries, entry } = restored;
  if (!entry) {
    const label = mode === "queue" ? "No stashed queue prompts in this chat" : "No stashed prompts in this chat";
    const elsewhere = entries.length > 0
      ? ` ${entries.length} ${entries.length === 1 ? "stash is" : "stashes are"} available in other chats. Open the browser to pick one`
      : "";
    ctx.ui.notify(`${label}.${elsewhere}`, "info");
    return;
  }
  const label = entry.inputMode === "queue" ? "Queue prompt" : "Prompt";
  notifyRestored(
    ctx,
    `${label} restored from ${entry.displayTimestamp}`,
    restored.failures ?? [],
    "restore never deletes stash files",
  );
}

async function toggleStash(ctx: ExtensionContext): Promise<void> {
  if (!isMainTui(ctx)) return;
  const draft = parseEditorDraft(ctx.ui.getEditorText());
  if (hasEditorContent(ctx)) {
    await stashCurrent(ctx);
    return;
  }
  await restoreLatest(ctx, draft.inputMode === "queue" ? "queue" : undefined);
}

// Keys from one input batch all run before the first browser mounts, and a second mount strands it.
const OPENING_BROWSERS = new WeakSet<object>();

async function browse(ctx: ExtensionContext): Promise<void> {
  if (!isMainTui(ctx) || OPENING_BROWSERS.has(ctx.ui)) return;
  OPENING_BROWSERS.add(ctx.ui);
  // The mounted browser owns input, so release after this turn; a browser that another
  // dialog displaced then stays reopenable.
  queueMicrotask(() => OPENING_BROWSERS.delete(ctx.ui));
  let state: BrowserState = { query: "", scope: "all", selectedIndex: 0 };
  let entries = readStore(() => loadEntriesForUi(ctx));
  while (true) {
    if (entries.length === 0) {
      ctx.ui.notify("No stashed prompts", "info");
      return;
    }
    const action = await showBrowser(ctx, entries, state);
    if (!action) return;
    const { query, scope, selectedId, selectedIndex } = action;
    state = { query, scope, selectedId, selectedIndex };
    try {
      const next = await runBrowserAction(ctx, action, entries);
      if (!next) return;
      entries = next;
    } catch (error) {
      if (!(error instanceof EntryConflictError)) throw error;
      ctx.ui.notify("That stash changed in another session, so OMS reloaded the browser", "warning");
      entries = readStore(() => loadEntriesForUi(ctx));
    }
  }
}

// Runs one browser action. Returns the stashes for the next opening, loaded in the action's own
// storage scope, or undefined when the browser stays closed.
async function runBrowserAction(
  ctx: ExtensionContext,
  action: NonNullable<BrowserAction>,
  entries: StashEntry[],
): Promise<StashEntry[] | undefined> {
  const thenReload = <T>(step: () => T) => readStore(() => {
    const value = step();
    return { value, next: loadEntriesForUi(ctx) };
  });
  if (action.type === "edit") {
    const edit = await editEntryText(ctx, action.entry, action.tui);
    if (typeof edit === "string") {
      ctx.ui.notify(edit === "unchanged" ? "Stashed prompt unchanged" : "Stashed prompt edit cancelled", "info");
      return entries;
    }
    const { value: result, next } = thenReload(() => setEntryText(action.entry, edit.text));
    ctx.ui.notify(
      result === "updated"
        ? "Stashed prompt updated"
        : result === "conflict-copy"
          ? "Stash changed concurrently; edited text was preserved as a new stash"
          : "OMS storage quota reached; edited text was preserved as a new stash",
      result === "quota-copy" ? "warning" : "info",
    );
    return next;
  }
  if (action.type === "toggle-lock") {
    const { next } = thenReload(() => setEntryLocked(action.entry, !action.entry.locked));
    ctx.ui.notify(action.entry.locked ? "Stash unlocked" : "Stash locked", "info");
    return next;
  }
  if (action.type === "submit-queue") {
    const { value: outcome, next } = thenReload(() => submitQueuedEntry(ctx, action.entry));
    return outcome === "drafted" ? undefined : next;
  }
  if (action.type === "delete") {
    if (action.entry.locked) {
      ctx.ui.notify("Unlock this stash before deleting it", "warning");
      return entries;
    }
    const confirmed = await ctx.ui.confirm(
      "Delete stashed prompt?",
      `Permanently delete “${truncateToWidth(action.entry.displayHeadline, 80)}” from ${action.entry.displayTimestamp}${action.scope === "all" ? ` · ${action.entry.displayOrigin}` : ""}?`,
      { initialIndex: 1 },
    );
    if (!confirmed) return entries;
    const { value: deleted, next } = thenReload(() => {
      const removed = removeEntry(action.entry);
      collectAttachmentGarbage(checkedStashDir(false));
      return removed;
    });
    ctx.ui.notify(deleted ? "Deleted stashed prompt" : "Stash entry was already deleted", "info");
    return next;
  }
  if (action.type === "delete-all") {
    const deletable = action.entries.filter((entry) => !entry.locked);
    const locked = action.entries.length - deletable.length;
    if (deletable.length === 0) {
      ctx.ui.notify("Every stash is locked; nothing was deleted", "warning");
      return entries;
    }
    const count = deletable.length;
    const scopeLabel = action.scope === "current" ? "from this chat" : "across all chats";
    const confirmed = await ctx.ui.confirm(
      `Delete unlocked stashes ${scopeLabel}?`,
      `Permanently delete ${count} unlocked stashed ${count === 1 ? "prompt" : "prompts"} ${scopeLabel}? ${locked} locked ${locked === 1 ? "stash is" : "stashes are"} protected. This ignores the current search and cannot be undone.`,
      { initialIndex: 1 },
    );
    if (!confirmed) return entries;
    const { value: deleted, next } = thenReload(() => removeEntries(deletable));
    ctx.ui.notify(
      deleted === count
        ? `Deleted ${deleted} unlocked stashed ${deleted === 1 ? "prompt" : "prompts"}; ${locked} locked protected`
        : `Deleted ${deleted} of ${count} unlocked stashed prompts; ${locked} locked protected`,
      "info",
    );
    return next;
  }
  if (hasEditorContent(ctx)) {
    ctx.ui.notify("Stash or clear the current editor before restoring a prompt", "warning");
    return entries;
  }
  const { entry } = action;
  const pop = action.type === "pop";
  const { failures, outcome } = readStore(() => {
    // A popped stash is deleted right after, so OMP makes its own image links.
    const restored = restoreIntoComposer(ctx, entry, { forceQueue: action.type === "queue", links: !pop });
    // A pop keeps a locked stash, and one whose attachments didn't all come back.
    if (!pop || entry.locked || restored.length > 0) {
      markEntryUsed(entry);
      return { failures: restored, outcome: "kept" as const };
    }
    try {
      removeEntry(entry);
    } catch (error) {
      if (!(error instanceof EntryConflictError)) throw error;
      return { failures: restored, outcome: "changed" as const };
    }
    collectAttachmentGarbage(checkedStashDir(false));
    return { failures: restored, outcome: "deleted" as const };
  });
  if (action.type === "queue") {
    notifyRestored(ctx, `Inserted queued draft from ${entry.displayTimestamp}`, failures, "stash file retained");
  } else if (!pop) {
    notifyRestored(ctx, `Restored prompt from ${entry.displayTimestamp}`, failures, "restore never deletes stash files");
  } else if (outcome === "deleted") {
    ctx.ui.notify(`Popped prompt from ${entry.displayTimestamp}; the stash is deleted`, "info");
  } else if (outcome === "changed") {
    ctx.ui.notify(`Restored prompt from ${entry.displayTimestamp}, but kept the stash because it changed in another session`, "warning");
  } else {
    notifyRestored(ctx, `Restored prompt from ${entry.displayTimestamp}`, failures, "locked stashes stay after a pop");
  }
  return undefined;
}

async function run(ctx: ExtensionContext, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    // Long enough for a storage error's path and the command that fixes it.
    const message = truncateToWidth(displayText(raw).replaceAll("\n", " "), 320);
    ctx.ui.notify(`OMS failed: ${message}`, "error");
  }
}

// Subagents load every plugin in-process, in print mode. Only the main TUI session owns the UI and
// the store's per-session work.
function isMainTui(ctx: ExtensionContext): boolean {
  return ctx.agent.kind === "main" && ctx.mode === "tui";
}

export default async function promptStash(pi: ExtensionAPI): Promise<void> {
  // Registration reads its own copy of the settings, so a subagent's load can't change the main
  // session's.
  const config = await loadPluginConfig(process.cwd());

  pi.on("session_start", async (_event, ctx) => {
    if (!isMainTui(ctx)) return;
    pluginConfig = await loadPluginConfig(ctx.cwd);
    installEditorBridge(ctx);
    warmStoragePermissions();
    if (pluginConfig.retentionDays > 0) {
      await run(ctx, async () => {
        loadEntries();
      });
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (isMainTui(ctx)) stopStoragePermissions();
  });

  if (config.stashShortcut !== "none") {
    pi.registerShortcut(config.stashShortcut as KeyId, {
      description: "Stash current prompt, or restore this chat's latest stash when the editor is empty",
      handler: async (ctx) => run(ctx, () => toggleStash(ctx)),
    });
  }

  if (config.browserShortcut !== "none") {
    pi.registerShortcut(config.browserShortcut as KeyId, {
      description: "Browse every chat's stashes, with this chat one key away",
      handler: async (ctx) => run(ctx, () => browse(ctx)),
    });
  }

  pi.registerCommand("stash", {
    description: "Browse stashes from this chat or all chats. Restore uses this chat",
    handler: async (args, ctx) =>
      run(ctx, async () => {
        const command = args.trim();
        if (command === "") return browse(ctx);
        if (command === "restore") return restoreLatest(ctx);
        ctx.ui.notify("Usage: /stash or /stash restore", "warning");
      }),
  });
}
