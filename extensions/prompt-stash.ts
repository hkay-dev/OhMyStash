import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
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
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components";
import { blobExtensionForImageMimeType } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { getEditorCommand, openInEditor } from "@oh-my-pi/pi-coding-agent/utils/external-editor";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
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

type InputMode = "normal" | "queue";

type EditorDraft = { inputMode: InputMode; text: string };

type BrowserLayout = "auto" | "split" | "stacked" | "compact";
type BrowserScope = "current" | "all";

type TimeFormat = "12-hour" | "24-hour";

interface PromptStashConfig {
  stashShortcut: string;
  browserShortcut: string;
  editorCommand: string;
  backgroundDimming: boolean;
  backgroundIntensity: number;
  backgroundSaturation: number;
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

type BrowserState = { query: string; scope: BrowserScope };
type BrowserAction =
  | ({ type: "restore"; entry: StashEntry } & BrowserState)
  | ({ type: "queue"; entry: StashEntry } & BrowserState)
  | ({ type: "submit-queue"; entry: StashEntry } & BrowserState)
  | ({ type: "toggle-lock"; entry: StashEntry } & BrowserState)
  | ({ type: "edit"; entry: StashEntry; tui: TUI } & BrowserState)
  | ({ type: "delete"; entry: StashEntry } & BrowserState)
  | ({ type: "delete-all"; entries: StashEntry[] } & BrowserState)
  | null;
type LoadResult = { entries: StashEntry[]; skipped: number };
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
const ASSET_REF = /^sha256:([a-f0-9]{64})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_SESSION_NAME_LENGTH = 512;
const MAX_WORKSPACE_NAME_LENGTH = 255;
const COLLAPSED_PASTE_TOKEN = /\[Paste #[1-9]\d*(?:,[^\]\n]*)?\]/;
const IMAGE_TOKEN = /\[Image #[1-9]\d*(?:,[^\]\n]*)?\]/;
const REPLACEMENT_WAIT = new Int32Array(new SharedArrayBuffer(4));
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const STALE_TEMP = /^\.[0-9a-f-]{36}\.tmp$/i;
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
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
const TRUECOLOR_SGR =
  /\x1b\[(?:(38|48);2;(\d+);(\d+);(\d+)|(38|48):2::(\d+):(\d+):(\d+))m/g;
const INTENSITY_OR_RESET_SGR = /\x1b\[(0|1|22|39)m/g;
const PLUGIN_NAME = "@hkay-dev/ohmystash";
const DEFAULT_CONFIG: PromptStashConfig = {
  stashShortcut: "alt+s",
  editorCommand: "",
  browserShortcut: "alt+shift+s",
  backgroundDimming: true,
  backgroundIntensity: 0.62,
  backgroundSaturation: 0.55,
  showIcons: true,
  layout: "auto",
  maxBodyRows: 36,
  retentionDays: 0,
  timeFormat: "12-hour",
};
let pluginConfig = { ...DEFAULT_CONFIG };
const ACTIVE_EDITORS = new WeakMap<object, CustomEditor>();

class EntryConflictError extends Error {}

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
    const dimBackground = raw["Dim background"];
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
      backgroundDimming:
        typeof dimBackground === "boolean"
          ? dimBackground
          : DEFAULT_CONFIG.backgroundDimming,
      backgroundIntensity:
        boundedNumber(
          raw["Background brightness (%)"],
          DEFAULT_CONFIG.backgroundIntensity * 100,
          30,
          95,
        ) / 100,
      backgroundSaturation:
        boundedNumber(
          raw["Background saturation (%)"],
          DEFAULT_CONFIG.backgroundSaturation * 100,
          0,
          100,
        ) / 100,
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

function checkedStashDir(create: boolean): string {
  const dir = stashDir();
  const created = create ? mkdirSync(dir, { recursive: true, mode: 0o700 }) : undefined;
  if (created !== undefined) syncCreatedDirectoryParents(created, dir);
  const stat = lstatSync(dir);
  const uid = process.getuid?.();
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("OMS storage directory must be an owner-only real directory");
  }
  return dir;
}

function checkedAttachmentDir(create: boolean): string {
  const root = checkedStashDir(create);
  const dir = join(root, "attachments");
  const created = create ? mkdirSync(dir, { recursive: true, mode: 0o700 }) : undefined;
  if (created !== undefined) syncDirectory(root);
  const stat = lstatSync(dir);
  const uid = process.getuid?.();
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("OMS attachment directory must be an owner-only real directory");
  }
  return dir;
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
    throw new Error("OMS attachment size is invalid");
  }
  const path = assetPath(ref);
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o077) !== 0 ||
    stat.size !== byteLength
  ) {
    throw new Error("OMS attachment is not a private regular file of the expected size");
  }
  const data = readFileSync(path);
  if (`sha256:${assetHash(data)}` !== ref) {
    throw new Error("OMS attachment failed its content hash check");
  }
  return data;
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
  try {
    const existing = readAsset(ref, data.byteLength);
    if (!existing.equals(data)) throw new Error("OMS attachment hash collision");
    if (displayPath !== finalPath) {
      try {
        linkSync(finalPath, displayPath);
        syncDirectory(dir);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    return ref;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
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
    try {
      linkSync(tempPath, finalPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const existing = readAsset(ref, data.byteLength);
      if (!existing.equals(data)) throw new Error("OMS attachment hash collision");
    }
    unlinkSync(tempPath);
    if (displayPath !== finalPath) {
      try {
        linkSync(finalPath, displayPath);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
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
        raw.mimeType.length > 128
      ) {
        return undefined;
      }
      attachments.push({ kind: "image", ref, byteLength, mimeType: raw.mimeType });
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
    return {
      id: parsed.id,
      text: parsed.text,
      inputMode,
      stashedAt: parsed.stashedAt,
      origin: origin ?? undefined,
      stashedAtMs: parsedDate.getTime(),
      attachments,
      locked,
      preserved,
    };
  } catch {
    return undefined;
  }
}

function isRecoverableTemp(path: string, uid: number | undefined): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (uid !== undefined && stat.uid !== uid) ||
      (stat.mode & 0o077) !== 0 ||
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
  const cutoff = Date.now() - STALE_TEMP_MS;
  const uid = process.getuid?.();
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
          (uid !== undefined && stat.uid !== uid) ||
          (stat.mode & 0o077) !== 0 ||
          stat.mtimeMs > cutoff ||
          isRecoverableTemp(path, uid)
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
}

function storageUsage(dir: string) {
  let count = 0;
  let bytes = 0;
  const handle = opendirSync(dir);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (!entry.name.endsWith(".json") && !entry.name.endsWith(".tmp")) continue;
      count += 1;
      if (count > MAX_ENTRY_FILES) break;
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
  let dir: string;
  try {
    dir = checkedStashDir(false);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { entries: [], skipped: 0 };
    throw error;
  }

  const selection = newestCandidateNames(dir);
  const names = selection.names;
  const entries: StashEntry[] = [];
  let skipped = selection.skipped;
  let totalBytes = 0;
  const uid = process.getuid?.();
  const seenIds = selection.tempCount > 0 ? new Set<string>() : undefined;

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
      if (
        !stat.isFile() ||
        (uid !== undefined && stat.uid !== uid) ||
        (stat.mode & 0o077) !== 0 ||
        stat.size <= 0 ||
        stat.size > MAX_ENTRY_FILE_BYTES ||
        (!overflowProtected && totalBytes + stat.size > MAX_TOTAL_BYTES)
      ) {
        skipped += 1;
        continue;
      }
      if (!overflowProtected) totalBytes += stat.size;
      const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}:${stat.uid}:${pluginConfig.timeFormat}`;
      const cached = recoveryFile ? undefined : ENTRY_CACHE.get(fileName);
      if (cached?.fingerprint === fingerprint) {
        entries.push(cached.entry);
        continue;
      }

      const bytes = Buffer.allocUnsafe(stat.size + 1);
      const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) {
        skipped += 1;
        continue;
      }
      const persisted = parsePersistedEntry(bytes.toString("utf8", 0, bytesRead));
      if (
        persisted === undefined ||
        (STALE_TEMP.test(fileName) && fileName !== `.${persisted.id}.tmp`) ||
        (preservedFile && !persisted.preserved) ||
        seenIds?.has(persisted.id)
      ) {
        skipped += 1;
        continue;
      }
      seenIds?.add(persisted.id);
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
        fileName,
        revision: assetHash(bytes.subarray(0, bytesRead)),
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
      if (!recoveryFile) ENTRY_CACHE.set(fileName, { fingerprint, entry });
    } catch {
      skipped += 1;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  const candidateNames = new Set(names);
  for (const cachedName of ENTRY_CACHE.keys()) {
    if (!candidateNames.has(cachedName)) ENTRY_CACHE.delete(cachedName);
  }

  entries.sort((a, b) => b.stashedAt.localeCompare(a.stashedAt));
  return { entries: pruneExpiredEntries(entries), skipped };
}

function saveEntry(
  text: string,
  inputMode: InputMode,
  attachments: StoredAttachment[],
  origin: StashOrigin | undefined,
  locked = false,
  preserveOnQuota = false,
): void {
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error("Prompt is too large to stash safely");
  }

  const dir = checkedStashDir(true);
  cleanupStaleTemps(dir);
  const id = randomUUID();
  const stashedAt = new Date().toISOString();
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
      throw new Error(
        "OMS storage quota reached across all chats. Open the stash browser and press g to manage it",
      );
    }
    checkedStashDir(false);
    renameSync(tempPath, finalPath);
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

function replaceEntry(
  entry: StashEntry,
  text: string,
  attachments: StoredAttachment[],
  locked: boolean,
): void {
  const dir = checkedStashDir(false);
  const publishedName = STALE_TEMP.test(entry.fileName)
    ? `${entry.stashedAt.replaceAll(":", "-")}-${entry.id}${entry.preserved ? ".preserved.json" : ".json"}`
    : entry.preserved
      ? basename(entry.fileName)
      : `${entry.stashedAt.replaceAll(":", "-")}-${entry.id}.json`;
  const finalPath = join(dir, publishedName);
  const sourcePath = join(dir, basename(entry.fileName));
  if (STALE_TEMP.test(entry.fileName)) {
    try {
      renameSync(sourcePath, finalPath);
      syncDirectory(dir);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  const tempPath = join(dir, `.${entry.id}.tmp`);
  const payload = `${JSON.stringify({
    id: entry.id,
    text,
    inputMode: entry.inputMode,
    stashedAt: entry.stashedAt,
    origin: entry.origin,
    attachments,
    locked,
    preserved: entry.preserved,
  }, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > MAX_ENTRY_FILE_BYTES) {
    throw new Error("Edited prompt is too large to persist safely");
  }
  let fd: number | undefined;
  let ownsTemp = false;
  try {
    fd = openReplacementTemp(tempPath);
    ownsTemp = true;
    let currentRevision: string;
    try {
      currentRevision = assetHash(readFileSync(finalPath));
    } catch {
      throw new EntryConflictError("Stash changed while it was being edited");
    }
    if (currentRevision !== entry.revision) {
      throw new EntryConflictError("Stash changed while it was being edited");
    }
    writeFileSync(fd, payload, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, finalPath);
    ownsTemp = false;
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

function setEntryText(entry: StashEntry, editedText: string): "updated" | "conflict-copy" {
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
    if (!(error instanceof EntryConflictError)) throw error;
    saveEntry(text, entry.inputMode, attachments, entry.origin, entry.locked, true);
    return "conflict-copy";
  }
}

function removeEntry(entry: StashEntry, sync = true): boolean {
  const dir = checkedStashDir(false);
  const path = join(dir, basename(entry.fileName));
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      ENTRY_CACHE.delete(entry.fileName);
      if (sync) syncDirectory(dir);
      return false;
    }
    throw error;
  }
  const uid = process.getuid?.();
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("Selected OMS entry is not a private regular file");
  }
  const bytes = readFileSync(path);
  const persisted = parsePersistedEntry(bytes.toString("utf8"));
  if (!persisted) throw new Error("Selected OMS entry changed and cannot be deleted safely");
  if (assetHash(bytes) !== entry.revision) {
    throw new EntryConflictError("Stash changed after the browser loaded");
  }
  if (persisted.locked) throw new Error("Locked stashes must be unlocked before deletion");
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      ENTRY_CACHE.delete(entry.fileName);
      if (sync) syncDirectory(dir);
      return false;
    }
    throw error;
  }
  ENTRY_CACHE.delete(entry.fileName);
  if (sync) syncDirectory(dir);
  return true;
}

function removeEntries(entries: StashEntry[]): number {
  const dir = checkedStashDir(false);
  let deleted = 0;
  try {
    for (const entry of entries) {
      if (removeEntry(entry, false)) deleted += 1;
    }
  } finally {
    syncDirectory(dir);
  }
  return deleted;
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
      entry.stashedAtMs >= cutoff
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
  syncDirectory(checkedStashDir(false));
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
    if (line) return line;
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

function buildPreviewModel(text: string, width: number): PreviewModel {
  const safe = displayText(text);
  const safeWidth = Math.max(1, width);

  if (/^[\x20-\x7e\n]*$/.test(safe)) {
    let totalRows = 0;
    let lineStart = 0;
    for (let index = 0; index <= safe.length; index += 1) {
      if (index !== safe.length && safe[index] !== "\n") continue;
      totalRows += Math.max(1, Math.ceil((index - lineStart) / safeWidth));
      lineStart = index + 1;
    }
    return { kind: "ascii", text: safe, width: safeWidth, totalRows };
  }

  const rowStarts = [0];
  const rowEnds: number[] = [];
  let rowWidth = 0;
  for (const part of GRAPHEME_SEGMENTER.segment(safe)) {
    if (part.segment === "\n") {
      rowEnds.push(part.index);
      rowStarts.push(part.index + 1);
      rowWidth = 0;
      continue;
    }
    const graphemeWidth = visibleWidth(part.segment);
    if (rowWidth > 0 && rowWidth + graphemeWidth > safeWidth) {
      rowEnds.push(part.index);
      rowStarts.push(part.index);
      rowWidth = 0;
    }
    rowWidth += graphemeWidth;
  }
  rowEnds.push(safe.length);
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

function pad(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width));
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function parseEditorDraft(text: string): EditorDraft {
  if (text === "/queue") return { inputMode: "queue", text: "" };
  if (/^\/queue[ \t\n]/.test(text)) return { inputMode: "queue", text: text.slice(7) };
  return { inputMode: "normal", text };
}

function activeEditor(ctx: ExtensionContext): CustomEditor | undefined {
  return ACTIVE_EDITORS.get(ctx.sessionManager);
}

function installEditorBridge(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const sessionManager = ctx.sessionManager;
  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    const editor = new CustomEditor(tui, theme, keybindings);
    (tui as { enableScopedInputRender?: (component: unknown) => void })?.enableScopedInputRender?.(editor);
    ACTIVE_EDITORS.set(sessionManager, editor);
    return editor;
  });
}

function captureDraft(ctx: ExtensionContext): CapturedDraft {
  const editor = activeEditor(ctx);
  if (!editor) {
    const draft = parseEditorDraft(ctx.ui.getEditorText());
    if (IMAGE_TOKEN.test(draft.text) || COLLAPSED_PASTE_TOKEN.test(draft.text)) {
      throw new Error("Restart OMP once so OhMyStash can attach to the native editor");
    }
    return { ...draft, attachments: [] };
  }
  const expandedDraft = parseEditorDraft(editor.getExpandedText());
  const images = editor.pendingImages;
  if (images.length > MAX_ATTACHMENTS) {
    throw new Error(`An OMS entry can contain at most ${MAX_ATTACHMENTS} attachments`);
  }
  let attachmentBytes = 0;
  const attachments: StoredAttachment[] = [];
  for (const image of images) {
    const data = Buffer.from(image.data, "base64");
    attachmentBytes += data.byteLength;
    if (attachmentBytes > MAX_ENTRY_ATTACHMENT_BYTES) {
      throw new Error("OMS attachments exceed the 128 MiB per-entry limit");
    }
    const extension = blobExtensionForImageMimeType(image.mimeType);
    const ref = persistAsset(data, extension);
    attachments.push({
      kind: "image",
      ref,
      byteLength: data.byteLength,
      mimeType: image.mimeType,
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

function resolveEntryAttachments(entry: StashEntry) {
  let body: string | undefined;
  const images: ImageContent[] = [];
  const imageLinks: string[] = [];
  for (const attachment of entry.attachments) {
    const data = readAsset(attachment.ref, attachment.byteLength);
    if (attachment.kind === "image") {
      images.push({ type: "image", data: data.toString("base64"), mimeType: attachment.mimeType });
      imageLinks.push(pathToFileURL(attachmentDisplayPath(attachment)).href);
    } else {
      if (body !== undefined) throw new Error("OMS entry contains multiple large text bodies");
      body = data.toString("utf8");
    }
  }
  return { body, images, imageLinks };
}

function setEditorDraft(ctx: ExtensionContext, entry: StashEntry, forceQueue = false): void {
  const prefix = forceQueue || entry.inputMode === "queue" ? "/queue " : "";
  const editor = activeEditor(ctx);
  if (!editor) {
    if (entry.attachments.length > 0) {
      throw new Error("Restart OMP once so OhMyStash can restore native attachments");
    }
    ctx.ui.setEditorText(`${prefix}${entry.text}`);
    return;
  }
  const resolved = resolveEntryAttachments(entry);
  const text = resolved.body ?? entry.text;
  if (text.length > 1_000 || text.includes("\n")) {
    editor.setDraft(prefix, resolved.images);
    editor.pendingImageLinks = resolved.imageLinks;
    editor.imageLinks = resolved.imageLinks;
    ctx.ui.pasteToEditor(text);
  } else {
    editor.setDraft(`${prefix}${text}`, resolved.images);
    editor.pendingImageLinks = resolved.imageLinks;
    editor.imageLinks = resolved.imageLinks;
    editor.tui?.requestRender();
  }
}

function submitQueuedEntry(ctx: ExtensionContext, entry: StashEntry): void {
  const editor = activeEditor(ctx);
  if (!editor) {
    throw new Error("Restart OMP once so OhMyStash can submit queued stashes");
  }
  setEditorDraft(ctx, entry, true);
  editor.handleInput("\r");
}


function editableEntryText(entry: StashEntry): string {
  const body = entry.attachments.find(
    (attachment): attachment is StoredTextAttachment => attachment.kind === "body",
  );
  return body ? readAsset(body.ref, body.byteLength).toString("utf8") : entry.text;
}

async function editEntry(
  ctx: ExtensionContext,
  entry: StashEntry,
  tui: TUI,
): Promise<"updated" | "conflict-copy" | "unchanged" | "cancelled"> {
  const original = editableEntryText(entry);
  const editorCommand = pluginConfig.editorCommand || getEditorCommand();
  let edited: string | null | undefined;
  if (editorCommand) {
    tui.stop();
    try {
      edited = await openInEditor(editorCommand, original, { extension: ".md" });
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
  return setEntryText(entry, edited);
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

function dimRgb(red: number, green: number, blue: number, isLight: boolean): [number, number, number] {
  const gray = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const saturation = pluginConfig.backgroundSaturation;
  const intensity = pluginConfig.backgroundIntensity;
  const softenAndAdjust = (channel: number) => {
    const softened = gray * (1 - saturation) + channel * saturation;
    return Math.round(
      isLight ? softened * intensity + 255 * (1 - intensity) : softened * intensity,
    );
  };
  return [softenAndAdjust(red), softenAndAdjust(green), softenAndAdjust(blue)];
}

function transformTruecolor(value: string, isLight: boolean, protect: boolean): string {
  return value.replace(
    TRUECOLOR_SGR,
    (
      _match,
      semicolonKind: string | undefined,
      semicolonRed: string | undefined,
      semicolonGreen: string | undefined,
      semicolonBlue: string | undefined,
      colonKind: string | undefined,
      colonRed: string | undefined,
      colonGreen: string | undefined,
      colonBlue: string | undefined,
    ) => {
      const kind = semicolonKind ?? colonKind!;
      const red = semicolonRed ?? colonRed!;
      const green = semicolonGreen ?? colonGreen!;
      const blue = semicolonBlue ?? colonBlue!;
      if (protect) return `\x1b[22;${kind};2;${red};${green};${blue}m`;
      const dimmed = dimRgb(Number(red), Number(green), Number(blue), isLight);
      return semicolonKind
        ? `\x1b[${kind};2;${dimmed[0]};${dimmed[1]};${dimmed[2]}m`
        : `\x1b[${kind}:2::${dimmed[0]}:${dimmed[1]}:${dimmed[2]}m`;
    },
  );
}

function dimAnsi(value: string, isLight: boolean): string {
  return transformTruecolor(value, isLight, false);
}

function protectModalColors(value: string): string {
  return transformTruecolor(value, false, true);
}

function dimTerminalOutput(
  value: string,
  isLight: boolean,
  dimTextAnsi: string,
): string {
  return dimAnsi(value, isLight).replace(
    INTENSITY_OR_RESET_SGR,
    (sequence, control: string) => {
      if (control === "0") return `${sequence}\x1b[2m${dimTextAnsi}`;
      if (control === "39") return `${sequence}${dimTextAnsi}`;
      return `${sequence}\x1b[2m`;
    },
  );
}

function brightenModalLines(lines: string[], theme: Theme): string[] {
  if (!pluginConfig.backgroundDimming) return lines;
  const textAnsi = protectModalColors(theme.getFgAnsi("text"));
  return lines.map((line) => {
    const bright = protectModalColors(line).replace(
      INTENSITY_OR_RESET_SGR,
      (_sequence, control: string) => {
        if (control === "0") return `\x1b[0;22;22m${textAnsi}`;
        if (control === "1") return "\x1b[1;1m";
        if (control === "22") return "\x1b[22;22m";
        return textAnsi;
      },
    );
    return `\x1b[22;22m${textAnsi}${bright}\x1b[39m\x1b[2m`;
  });
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
  return literalMatches.length > 0
    ? literalMatches
    : fuzzyFilter(entries, query, (entry) =>
        includeOrigin ? entry.searchTextAll : entry.searchText,
      );
}

function showBrowser(
  ctx: ExtensionContext,
  entries: StashEntry[],
  initialQuery = "",
  initialScope: BrowserScope = "current",
): Promise<BrowserAction> {
  let restoreBackground: (() => void) | undefined;
  // Capture synchronous UI setup failures so terminal restoration always runs.
  return (async () => ctx.ui.custom<BrowserAction>(
    (tui, theme, _keybindings, done) => {
      if (pluginConfig.backgroundDimming) {
        const originalWrite = tui.terminal.write;
        const dimTextAnsi = dimAnsi(theme.getFgAnsi("text"), theme.isLight);
        tui.terminal.write = (data: string) => {
          const uniformlyDimmed = dimTerminalOutput(data, theme.isLight, dimTextAnsi);
          originalWrite.call(tui.terminal, `\x1b[2m${dimTextAnsi}${uniformlyDimmed}`);
        };
        restoreBackground = () => {
          tui.terminal.write = originalWrite;
          originalWrite.call(tui.terminal, "\x1b[0m");
          tui.resetDisplay();
        };
        tui.requestRender();
      }
      const searchInput = new Input();
      searchInput.prompt = "/";
      searchInput.setValue(initialQuery);
      const currentSessionId = ctx.sessionManager.getSessionId();
      const currentEntries = entries.filter((entry) => isCurrentChat(entry, currentSessionId));
      let scope = initialScope;
      let scopedEntries = scope === "current" ? currentEntries : entries;
      let searching = false;
      let filteredEntries = filterStashEntries(
        scopedEntries,
        initialQuery,
        scope === "all",
      );
      let selected = 0;
      let previewOffset = 0;
      let previewRows = 1;
      let previewCacheKey = "";
      let previewCache: PreviewModel | undefined;

      const selectedEntry = () => filteredEntries[selected];
      const resetPreview = () => {
        previewOffset = 0;
        previewCacheKey = "";
      };
      const applySearch = () => {
        filteredEntries = filterStashEntries(
          scopedEntries,
          searchInput.getValue(),
          scope === "all",
        );
        selected = 0;
        resetPreview();
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
        resetPreview();
        tui.requestRender();
      };
      const previewModel = (width: number) => {
        const entry = selectedEntry();
        if (!entry) return undefined;
        const key = `${entry.id}:${width}`;
        if (key !== previewCacheKey || !previewCache) {
          previewCacheKey = key;
          previewCache = buildPreviewModel(entry.text, width);
        }
        return previewCache;
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
      const browserState = (): BrowserState => ({ query: searchInput.getValue(), scope });
      const finishSelected = (type: "restore" | "queue" | "submit-queue") => {
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
          previewCacheKey = "";
          searchInput.invalidate();
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.ctrl("c"))) {
            done(null);
            return;
          }
          if (searching) {
            if (matchesKey(data, Key.escape)) {
              exitSearch(true);
            } else if (matchesKey(data, Key.enter)) {
              finishSelected("restore");
            } else if (data === "q") {
              finishSelected("queue");
            } else if (data === "Q") {
              finishSelected("submit-queue");
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
          if (data === "/") {
            searching = true;
            searchInput.focused = true;
            tui.requestRender();
          } else if (data === "g") {
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
          } else if (matchesKey(data, Key.pageUp) || data === "[") {
            previewOffset = Math.max(0, previewOffset - previewRows);
            tui.requestRender();
          } else if (matchesKey(data, Key.pageDown) || data === "]") {
            previewOffset += previewRows;
            tui.requestRender();
          } else if (matchesKey(data, Key.enter) || data === "r") {
            finishSelected("restore");
          } else if (data === "q") {
            finishSelected("queue");
          } else if (data === "Q") {
            finishSelected("submit-queue");
          } else if (data === "e") {
            finishEdit();
          } else if (data === "l") {
            finishToggleLock();
          } else if (data === "d" || matchesKey(data, Key.delete)) {
            finishDelete();
          } else if (data === "D") {
            finishDeleteAll();
          }
        },
        render(width: number) {
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
          const outerRow = (text = "") => `${border("│")}${pad(text, outerWidth)}${border("│")}`;
          const searchIcon = theme.fg(
            "accent",
            pluginConfig.showIcons ? theme.symbol("icon.search") : "/",
          );
          const stashGlyph = pluginConfig.showIcons ? theme.symbol("icon.cache") : "";
          const draftGlyph = pluginConfig.showIcons ? theme.symbol("icon.file") : "[D]";
          const savedGlyph = pluginConfig.showIcons ? theme.symbol("icon.folder") : "";
          const queueGlyph = pluginConfig.showIcons ? theme.symbol("icon.output") : "[Q]";
          const timeGlyph = pluginConfig.showIcons ? theme.symbol("icon.time") : "";
          const labelWithIcon = (glyph: string, label: string) =>
            glyph ? `${glyph} ${label}` : label;
          const keyHint = (key: string, label: string) =>
            `${theme.fg("accent", key)} ${theme.fg("dim", label)}`;
          const promptFooter = entry
            ? (searching
                ? [
                    keyHint("Enter", "Restore"),
                    keyHint("q", "Draft"),
                    keyHint("Q", "Queue"),
                  ]
                : [
                    keyHint("Enter", "Restore"),
                    keyHint("q", "Draft"),
                    keyHint("Q", "Queue"),
                    keyHint("l", entry.locked ? "Unlock" : "Lock"),
                    keyHint("d", "Delete"),
                    keyHint("e", "Edit"),
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
          const topBorder = (): string => {
            const title = theme.fg(
              "accent",
              theme.bold(
                truncateToWidth(
                  ` ${labelWithIcon(stashGlyph, "OhMyStash")} `,
                  Math.max(1, renderWidth - 2),
                  "",
                ),
              ),
            );
            const fill = Math.max(0, renderWidth - 2 - visibleWidth(title));
            return `${border("┌")}${title}${border("─".repeat(fill))}${border("┐")}`;
          };
          const bottomBorder = () => border(`└${"─".repeat(Math.max(0, renderWidth - 2))}┘`);
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

          if (pluginConfig.layout === "compact" || terminalRows < 10 || renderWidth < 32) {
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
              return brightenModalLines(
                [
                  theme.fg("accent", header),
                  truncateToWidth(searchLine, renderWidth, ""),
                  theme.fg(
                    "muted",
                    noCurrentStashes ? "No stashes in this chat" : "No matching prompts",
                  ),
                  ...(noCurrentStashes && entries.length > 0
                    ? [theme.fg("dim", `${entries.length} elsewhere · press g`)]
                    : []),
                ].slice(0, terminalRows),
                theme,
              );
            }
            const visiblePreviewRows = Math.max(0, terminalRows - 2);
            previewRows = Math.max(1, visiblePreviewRows);
            const model = previewModel(renderWidth)!;
            const maxPreviewOffset = Math.max(0, model.totalRows - previewRows);
            previewOffset = Math.min(previewOffset, maxPreviewOffset);
            const page = previewPage(model, previewOffset, visiblePreviewRows);
            return brightenModalLines(
              [
                theme.fg("accent", header),
                truncateToWidth(searchLine, renderWidth, ""),
                ...page.map((line) => truncateToWidth(line, renderWidth, "")),
              ].slice(0, terminalRows),
              theme,
            );
          }

          const useSplitLayout =
            (pluginConfig.layout === "split" && renderWidth >= 72) ||
            (pluginConfig.layout === "auto" && renderWidth >= 92);
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
              topBorder(),
              outerRow(renderSearchBar(outerWidth)),
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
                `${border("│")}${pad(` ${left}`, leftWidth)}${border("│")}${pad(` ${right}`, rightWidth)}${border("│")}`,
              );
            }
            if (entry) {
              lines.push(
                border(`├${"─".repeat(leftWidth)}┼${"─".repeat(rightWidth)}┤`),
                `${border("│")}${pad("", leftWidth)}${border("│")}${pad(` ${promptFooter}`, rightWidth)}${border("│")}`,
              );
            }
            lines.push(
              border(`├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`),
              outerRow(` ${browserFooter}`),
              bottomBorder(),
            );
            return brightenModalLines(lines, theme);
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
            topBorder(),
            outerRow(renderSearchBar(outerWidth)),
            `${border("├")}${ruleCell(labelWithIcon(savedGlyph, `${activeScopeLabel} · ${position}`), renderWidth - 2)}${border("┤")}`,
          ];
          for (let row = 0; row < listRows; row += 1) {
            const index = firstListIndex + row;
            const item = filteredEntries[index];
            lines.push(
              outerRow(
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
            `${border("├")}${ruleCell(previewLabel, renderWidth - 2)}${border("┤")}`,
            outerRow(
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
            lines.push(outerRow(` ${theme.fg("dim", stashOriginDetails(entry.origin))}`));
          }
          for (let row = 0; row < previewRows; row += 1) {
            lines.push(outerRow(` ${page[row] ?? ""}`));
          }
          if (entry) {
            lines.push(
              border(`├${"─".repeat(Math.max(0, renderWidth - 2))}┤`),
              outerRow(` ${promptFooter}`),
            );
          }
          lines.push(outerRow(` ${browserFooter}`), bottomBorder());
          return brightenModalLines(lines, theme);
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "90%", maxHeight: "100%" },
    },
  ))().finally(() => restoreBackground?.());
}

function loadEntriesForUi(ctx: ExtensionContext): StashEntry[] {
  const result = loadEntries();
  if (result.skipped > 0) {
    const noun = result.skipped === 1 ? "entry was" : "entries were";
    ctx.ui.notify(
      `${result.skipped} OMS ${noun} omitted because of safety checks or limits`,
      "warning",
    );
  }
  return result.entries;
}

async function stashCurrent(ctx: ExtensionContext): Promise<void> {
  const draft = captureDraft(ctx);
  if (draft.text.length === 0 && draft.attachments.length === 0) {
    ctx.ui.notify("Nothing to stash", "info");
    return;
  }
  saveEntry(draft.text, draft.inputMode, draft.attachments, currentStashOrigin(ctx));
  clearEditorAfterStash(ctx, draft.inputMode);
  const label = draft.inputMode === "queue" ? "Queue prompt" : "Prompt";
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
  if (ctx.mode !== "tui") return;
  const current = parseEditorDraft(ctx.ui.getEditorText());
  if (current.text.length > 0) {
    ctx.ui.notify("Stash or clear the current editor before restoring a prompt", "warning");
    return;
  }
  const entries = loadEntriesForUi(ctx);
  const currentSessionId = ctx.sessionManager.getSessionId();
  const currentEntries = entries.filter((candidate) => isCurrentChat(candidate, currentSessionId));
  const mode = requestedMode ?? (current.inputMode === "queue" ? "queue" : undefined);
  const entry = mode
    ? currentEntries.find((candidate) => candidate.inputMode === mode)
    : currentEntries[0];
  if (!entry) {
    const label = mode === "queue" ? "No stashed queue prompts in this chat" : "No stashed prompts in this chat";
    const elsewhere = entries.length > 0
      ? ` ${entries.length} ${entries.length === 1 ? "stash is" : "stashes are"} available in other chats. Open the browser and press g`
      : "";
    ctx.ui.notify(`${label}.${elsewhere}`, "info");
    return;
  }
  setEditorDraft(ctx, entry);
  const label = entry.inputMode === "queue" ? "Queue prompt" : "Prompt";
  ctx.ui.notify(
    `${label} restored from ${entry.displayTimestamp}; restore never deletes stash files`,
    "info",
  );
}

async function toggleStash(ctx: ExtensionContext): Promise<void> {
  const draft = parseEditorDraft(ctx.ui.getEditorText());
  if (draft.text.length > 0) {
    await stashCurrent(ctx);
    return;
  }
  await restoreLatest(ctx, draft.inputMode === "queue" ? "queue" : undefined);
}

async function browse(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") return;
  let query = "";
  let scope: BrowserScope = "current";
  while (true) {
    const entries = loadEntriesForUi(ctx);
    if (entries.length === 0) {
      ctx.ui.notify("No stashed prompts", "info");
      return;
    }
    const action = await showBrowser(ctx, entries, query, scope);
    if (!action) return;
    query = action.query;
    scope = action.scope;
    if (action.type === "edit") {
      const result = await editEntry(ctx, action.entry, action.tui);
      ctx.ui.notify(
        result === "updated"
          ? "Stashed prompt updated"
          : result === "conflict-copy"
            ? "Stash changed concurrently; edited text was preserved as a new stash"
            : result === "unchanged"
              ? "Stashed prompt unchanged"
              : "Stashed prompt edit cancelled",
        "info",
      );
      continue;
    }
    if (action.type === "toggle-lock") {
      setEntryLocked(action.entry, !action.entry.locked);
      ctx.ui.notify(action.entry.locked ? "Stash unlocked" : "Stash locked", "info");
      continue;
    }
    if (action.type === "submit-queue") {
      submitQueuedEntry(ctx, action.entry);
      continue;
    }
    if (action.type === "delete") {
      if (action.entry.locked) {
        ctx.ui.notify("Unlock this stash before deleting it", "warning");
        continue;
      }
      const confirmed = await ctx.ui.confirm(
        "Delete stashed prompt?",
        `Permanently delete “${truncateToWidth(action.entry.displayHeadline, 80)}” from ${action.entry.displayTimestamp}${action.scope === "all" ? ` · ${action.entry.displayOrigin}` : ""}?`,
        { initialIndex: 1 },
      );
      if (!confirmed) continue;
      const deleted = removeEntry(action.entry);
      ctx.ui.notify(deleted ? "Deleted stashed prompt" : "Stash entry was already deleted", "info");
      continue;
    }
    if (action.type === "delete-all") {
      const deletable = action.entries.filter((entry) => !entry.locked);
      const locked = action.entries.length - deletable.length;
      if (deletable.length === 0) {
        ctx.ui.notify("Every stash is locked; nothing was deleted", "warning");
        continue;
      }
      const count = deletable.length;
      const scopeLabel = action.scope === "current" ? "from this chat" : "across all chats";
      const confirmed = await ctx.ui.confirm(
        `Delete unlocked stashes ${scopeLabel}?`,
        `Permanently delete ${count} unlocked stashed ${count === 1 ? "prompt" : "prompts"} ${scopeLabel}? ${locked} locked ${locked === 1 ? "stash is" : "stashes are"} protected. This ignores the current search and cannot be undone.`,
        { initialIndex: 1 },
      );
      if (!confirmed) continue;
      const deleted = removeEntries(deletable);
      ctx.ui.notify(
        deleted === count
          ? `Deleted ${deleted} unlocked stashed ${deleted === 1 ? "prompt" : "prompts"}; ${locked} locked protected`
          : `Deleted ${deleted} of ${count} unlocked stashed prompts; ${locked} locked protected`,
        "info",
      );
      continue;
    }
    const current = parseEditorDraft(ctx.ui.getEditorText());
    if (current.text.length > 0) {
      ctx.ui.notify("Stash or clear the current editor before restoring a prompt", "warning");
      continue;
    }
    if (action.type === "queue") {
      setEditorDraft(ctx, action.entry, true);
      ctx.ui.notify(
        `Inserted queued draft from ${action.entry.displayTimestamp}; stash file retained`,
        "info",
      );
    } else {
      setEditorDraft(ctx, action.entry);
      ctx.ui.notify(
        `Restored prompt from ${action.entry.displayTimestamp}; restore never deletes stash files`,
        "info",
      );
    }
    return;
  }
}

async function run(ctx: ExtensionContext, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = truncateToWidth(displayText(raw).replaceAll("\n", " "), 160);
    ctx.ui.notify(`OMS failed: ${message}`, "error");
  }
}

export default async function promptStash(pi: ExtensionAPI): Promise<void> {
  pluginConfig = await loadPluginConfig(process.cwd());

  pi.on("session_start", async (_event, ctx) => {
    pluginConfig = await loadPluginConfig(ctx.cwd);
    installEditorBridge(ctx);
    if (pluginConfig.retentionDays > 0) {
      await run(ctx, async () => {
        loadEntries();
      });
    }
  });

  if (pluginConfig.stashShortcut !== "none") {
    pi.registerShortcut(pluginConfig.stashShortcut as KeyId, {
      description: "Stash current prompt, or restore this chat's latest stash when the editor is empty",
      handler: async (ctx) => run(ctx, () => toggleStash(ctx)),
    });
  }

  if (pluginConfig.browserShortcut !== "none") {
    pi.registerShortcut(pluginConfig.browserShortcut as KeyId, {
      description: "Browse this chat's stashes, with every chat one key away",
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
