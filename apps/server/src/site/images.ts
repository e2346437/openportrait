import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { resolveInside } from "../galleries/files.js";
import type { PhotoSource } from "./types.js";

/** Widths written for every picked photo. Smaller screens get the small ones. */
export const SITE_WIDTHS = [640, 1280, 2000] as const;

export interface PreparedImage {
  /** Public file name stem, derived from a hash so no file name or folder from the studio ever appears on the site. */
  key: string;
  width: number;
  height: number;
  /** Files to write, with their path in the site and where they are on disk. Ascending width. */
  files: Array<{ name: string; file: string; width: number }>;
}

export const imageKey = (src: PhotoSource) => crypto.createHash("sha1").update(`site:${src.contentHash}`).digest("hex").slice(0, 10);

/**
 * Makes the web copies of one picked photo. They are re-encoded from the original (rotated, resized, color profile
 * kept) and carry no EXIF, so camera serials and GPS positions never leave the studio. Results are cached on disk.
 * Returns null when the original is gone.
 */
export async function prepareImage(src: PhotoSource, galleriesDir: string, cacheDir: string): Promise<PreparedImage | null> {
  const key = imageKey(src);
  const dir = path.join(cacheDir, "site");
  fs.mkdirSync(dir, { recursive: true });
  let original: string | null = null;
  const files: PreparedImage["files"] = [];
  let width = 0;
  let height = 0;
  for (const target of SITE_WIDTHS) {
    const file = path.join(dir, `${key}-${target}.webp`);
    if (!fs.existsSync(file)) {
      if (original === null) {
        original = resolveInside(galleriesDir, src.relPath);
        if (!fs.existsSync(original)) return null;
      }
      const tmp = `${file}.${process.pid}.tmp`;
      await sharp(original, { failOn: "none" }).rotate().resize({ width: target, withoutEnlargement: true }).webp({ quality: target >= 2000 ? 80 : 78, effort: 4 }).keepIccProfile().toFile(tmp);
      fs.renameSync(tmp, file);
    }
    const meta = await sharp(file).metadata();
    const w = meta.width ?? target;
    if (files.some((f) => f.width === w)) continue; // the original is smaller than this size
    files.push({ name: `images/${key}-${w}.webp`, file, width: w });
    width = w;
    height = meta.height ?? 0;
  }
  const largest = files.at(-1);
  if (!largest) return null;
  return { key, width, height, files };
}

/** The 1200x630 picture social networks show when the site is shared. */
export async function prepareShareImage(src: PhotoSource, galleriesDir: string, cacheDir: string): Promise<{ name: string; file: string } | null> {
  const key = imageKey(src);
  const dir = path.join(cacheDir, "site");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key}-share.jpg`);
  if (!fs.existsSync(file)) {
    const original = resolveInside(galleriesDir, src.relPath);
    if (!fs.existsSync(original)) return null;
    const tmp = `${file}.${process.pid}.tmp`;
    await sharp(original, { failOn: "none" }).rotate().resize({ width: 1200, height: 630, fit: "cover" }).jpeg({ quality: 82, mozjpeg: true }).toFile(tmp);
    fs.renameSync(tmp, file);
  }
  return { name: `images/share-${key}.jpg`, file };
}
