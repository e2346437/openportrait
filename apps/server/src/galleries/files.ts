import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Image types that become gallery photos. RAW files and sidecars are ignored. */
export const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".avif", ".heic", ".heif"]);

const IGNORED_NAMES = new Set(["@eaDir", "#recycle", "#snapshot", "Thumbs.db", "desktop.ini", "lost+found", "$RECYCLE.BIN", "System Volume Information"]);
const PARTIAL_EXT = new Set([".tmp", ".part", ".partial", ".crdownload", ".download"]);

/** Names the watcher never looks inside: hidden, underscore-prefixed, NAS system folders. */
export function isIgnoredName(name: string): boolean {
  return name.startsWith(".") || name.startsWith("_") || IGNORED_NAMES.has(name);
}

/**
 * Underscore-prefixed folders are private, but underscore-prefixed files are normal:
 * Nikon names Adobe RGB frames "_DSC1234.jpg". Only hidden and system files are skipped.
 */
export function isImageFile(name: string): boolean {
  if (name.startsWith(".") || IGNORED_NAMES.has(name)) return false;
  const ext = path.extname(name).toLowerCase();
  if (PARTIAL_EXT.has(ext)) return false;
  return IMAGE_EXT.has(ext);
}

/** Any file worth tracking in an Originals folder: everything except hidden, system and half-written files. */
export function isTrackableFile(name: string): boolean {
  if (name.startsWith(".") || IGNORED_NAMES.has(name)) return false;
  return !PARTIAL_EXT.has(path.extname(name).toLowerCase());
}

/** Joins a share-relative path onto a root and refuses anything that escapes it. */
export function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const r = path.resolve(root);
  if (abs !== r && !abs.startsWith(r + path.sep)) throw new Error(`Path escapes ${root}: ${rel}`);
  return abs;
}

export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => h.update(chunk))
      .on("end", () => resolve(h.digest("hex")));
  });
}

export function readDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export const newId = () => crypto.randomBytes(9).toString("base64url");

/** "Smith Family" → "smith-family" for gallery URLs. */
export function slugify(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "gallery"
  );
}

/** A readable gallery title from a folder name: "2026-11-14 Family - Smith Family" → "Smith Family". */
export function titleFromFolder(name: string): string {
  const m = /^\d{4}-\d{2}-\d{2}\s+(?:.+?\s+-\s+)?(.+)$/.exec(name);
  return (m?.[1] ?? name).trim() || name;
}
