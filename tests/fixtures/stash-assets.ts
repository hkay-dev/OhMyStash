import { existsSync, linkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Stash attachments as another writer stores them: OMP 19.2 doesn't let a plugin read a composer's
// images or pasted blocks, so tests write the asset files and the entry's `attachments` list directly.

// Writes the bytes under their SHA-256, with a display link when `extension` is given, and returns the ref.
export function storeAsset(stashDir: string, data: Buffer, extension?: string): string {
  const dir = join(stashDir, "attachments");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hash = new Bun.SHA256().update(data).digest("hex");
  const path = join(dir, hash);
  if (!existsSync(path)) writeFileSync(path, data, { mode: 0o600 });
  if (extension && !existsSync(`${path}.${extension}`)) linkSync(path, `${path}.${extension}`);
  return `sha256:${hash}`;
}

export function imageAttachment(stashDir: string, label: string, detail?: "original") {
  const data = Buffer.from(label);
  return {
    kind: "image" as const,
    ref: storeAsset(stashDir, data, "png"),
    byteLength: data.byteLength,
    mimeType: "image/png",
    ...(detail === undefined ? {} : { detail }),
  };
}

export function bodyAttachment(stashDir: string, text: string) {
  const data = Buffer.from(text, "utf8");
  return {
    kind: "body" as const,
    ref: storeAsset(stashDir, data, "txt"),
    byteLength: data.byteLength,
    charCount: text.length,
    lineCount: text.split("\n").length,
  };
}
