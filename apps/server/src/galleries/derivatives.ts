import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, isNull } from "drizzle-orm";
import exifr from "exifr";
import sharp from "sharp";
import { tables, type Db } from "@openportrait/db";
import { defineJob } from "@openportrait/jobs";
import { DERIVATIVES_JOB } from "./ingest.js";

const { gallery, gallerySet, photo } = tables;

/** Sizes served to browsers. Originals are only ever streamed for downloads. */
export const VARIANTS = {
  /** Grid tiles: 640 px tall (wide photos up to 1280 px wide). */
  thumb: { width: 1280, height: 640, format: "webp", quality: 78 },
  /** Lightbox and cover: 2048 px on the long edge. */
  preview: { width: 2048, height: 2048, format: "webp", quality: 82 },
  /** "Web size" downloads: a 2048 px JPEG, made on first request. */
  web: { width: 2048, height: 2048, format: "jpeg", quality: 88 },
} as const;
export type Variant = keyof typeof VARIANTS;

sharp.cache(false);
sharp.concurrency(2);

/** JPEG quality range offered for "web size" downloads (Settings > Galleries). */
export const WEB_QUALITY = { min: 60, max: 100, default: 88 } as const;

/** The studio's chosen web-size quality, clamped to the supported range. */
export function webQualityOf(settings: { get(key: "galleries.webQuality"): number | undefined }): number {
  const q = Math.round(Number(settings.get("galleries.webQuality")));
  return Number.isFinite(q) ? Math.min(WEB_QUALITY.max, Math.max(WEB_QUALITY.min, q)) : WEB_QUALITY.default;
}

/** The quality is part of the web file's name, so changing the setting never serves an older render. */
export function derivativePath(cacheDir: string, galleryId: string, photoId: string, version: number, variant: Variant, quality?: number): string {
  const ext = VARIANTS[variant].format === "jpeg" ? "jpg" : "webp";
  const q = variant === "web" && quality !== undefined && quality !== WEB_QUALITY.default ? `-q${quality}` : "";
  return path.join(cacheDir, "galleries", galleryId, `${photoId}-v${version}-${variant}${q}.${ext}`);
}

export function watermarkedPath(cacheDir: string, galleryId: string, photoId: string, version: number, variant: "thumb" | "preview", hash: string): string {
  return path.join(cacheDir, "galleries", galleryId, `${photoId}-v${version}-${variant}-wm-${hash}.webp`);
}

/** Renders one variant from the original. Writes to a temp file first so a half-written file is never served. */
export async function renderVariant(source: string, dest: string, variant: Variant, quality?: number): Promise<void> {
  const v = VARIANTS[variant];
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  let img = sharp(source, { failOn: "none" }).rotate().resize({ width: v.width, height: v.height, fit: "inside", withoutEnlargement: true });
  img = v.format === "jpeg" ? img.jpeg({ quality: quality ?? v.quality, mozjpeg: true }) : img.webp({ quality: v.quality, effort: 4 });
  // Keep the color profile so wide-gamut exports look right; drop the rest of the metadata.
  await img.keepIccProfile().toFile(tmp);
  fs.renameSync(tmp, dest);
}

const UNSUPPORTED = /unsupported image format|bad seek|no decoder|heif: |not a known file format|corrupt|premature end/i;

/** Pulls the handful of EXIF fields the lightbox shows. */
async function readExif(file: string): Promise<{ takenAt: Date | null; exif: Record<string, unknown> | null }> {
  try {
    const e = await exifr.parse(file, { pick: ["DateTimeOriginal", "CreateDate", "Make", "Model", "LensModel", "FNumber", "ExposureTime", "ISO", "FocalLength"] });
    if (!e) return { takenAt: null, exif: null };
    const taken = e.DateTimeOriginal ?? e.CreateDate;
    const { DateTimeOriginal: _a, CreateDate: _b, ...rest } = e;
    return { takenAt: taken instanceof Date && !Number.isNaN(taken.getTime()) ? taken : null, exif: Object.keys(rest).length ? rest : null };
  } catch {
    return { takenAt: null, exif: null };
  }
}

/** Registers the job that turns a new or re-exported photo into thumbnails, previews and a blurred placeholder. */
export function registerDerivativesJob(dirs: { galleriesDir: string; cacheDir: string }) {
  return defineJob(
    DERIVATIVES_JOB,
    async ({ photoId, version }: { photoId: string; version: number }, { db, attempt, logger }) => {
      const p = db.select().from(photo).where(eq(photo.id, photoId)).get();
      if (!p || p.version !== version || p.state === "missing") return; // superseded by a newer export, or gone
      const source = path.join(dirs.galleriesDir, p.relPath);
      try {
        const meta = await sharp(source, { failOn: "none" }).metadata();
        const width = meta.autoOrient?.width ?? meta.width;
        const height = meta.autoOrient?.height ?? meta.height;
        for (const variant of ["thumb", "preview"] as const) {
          await renderVariant(source, derivativePath(dirs.cacheDir, p.galleryId, p.id, version, variant), variant);
        }
        const tiny = await sharp(source, { failOn: "none" }).rotate().resize({ width: 24, height: 24, fit: "inside" }).webp({ quality: 40 }).toBuffer();
        const { takenAt, exif } = await readExif(source);
        db.update(photo)
          .set({ width, height, takenAt, exif, placeholder: `data:image/webp;base64,${tiny.toString("base64")}`, state: "ready", error: null, updatedAt: new Date() })
          .where(and(eq(photo.id, p.id), eq(photo.version, version)))
          .run();
        removeOldVersions(dirs.cacheDir, p.galleryId, p.id, version);
        fillCovers(db, p.galleryId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (UNSUPPORTED.test(message) || attempt >= 3) {
          logger.warn({ photo: p.relPath, err: message }, "photo could not be read");
          db.update(photo)
            .set({ state: UNSUPPORTED.test(message) ? "unsupported" : "error", error: message.slice(0, 300), updatedAt: new Date() })
            .where(eq(photo.id, p.id))
            .run();
          return;
        }
        throw err; // e.g. the share was briefly unavailable: retry with backoff
      }
    },
    { maxAttempts: 3 },
  );
}

function removeOldVersions(cacheDir: string, galleryId: string, photoId: string, keep: number): void {
  const dir = path.join(cacheDir, "galleries", galleryId);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const prefix = `${photoId}-v`;
  for (const n of names) {
    if (n.startsWith(prefix) && !n.startsWith(`${prefix}${keep}-`)) fs.rmSync(path.join(dir, n), { force: true });
  }
}

/** A gallery or set without a chosen cover uses its first ready photo, so a new gallery never looks empty. */
export function fillCovers(db: Db, galleryId: string): void {
  const firstReady = (setId?: string) =>
    db
      .select({ id: photo.id })
      .from(photo)
      .where(and(eq(photo.galleryId, galleryId), eq(photo.state, "ready"), eq(photo.hidden, false), setId ? eq(photo.setId, setId) : undefined))
      .orderBy(asc(photo.sort), asc(photo.filename))
      .get();
  const g = db.select({ coverPhotoId: gallery.coverPhotoId }).from(gallery).where(eq(gallery.id, galleryId)).get();
  if (g && !g.coverPhotoId) {
    const first = firstReady();
    if (first) db.update(gallery).set({ coverPhotoId: first.id }).where(eq(gallery.id, galleryId)).run();
  }
  for (const s of db.select({ id: gallerySet.id }).from(gallerySet).where(and(eq(gallerySet.galleryId, galleryId), isNull(gallerySet.coverPhotoId))).all()) {
    const first = firstReady(s.id);
    if (first) db.update(gallerySet).set({ coverPhotoId: first.id }).where(eq(gallerySet.id, s.id)).run();
  }
}
