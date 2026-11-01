import { asc, eq } from "drizzle-orm";
import { DEFAULT_DESIGN, tables, type Db, type GalleryDesign } from "@openportrait/db";
import type { Secrets } from "../secrets.js";
import type { Variant } from "./derivatives.js";

const { gallerySet, photo } = tables;
type Gallery = typeof tables.gallery.$inferSelect;
type GallerySet = typeof tables.gallerySet.$inferSelect;
type Photo = typeof tables.photo.$inferSelect;

/** Signed, versioned media URL. The version changes on every re-export, so responses can be cached forever. */
export function mediaUrl(secrets: Secrets, p: Pick<Photo, "id" | "version">, variant: Variant): string {
  return `/media/${p.id}/${p.version}/${variant}?s=${secrets.sign("media", `${p.id}:${p.version}:${variant}`)}`;
}

export function designOf(g: Pick<Gallery, "design">): GalleryDesign {
  return { ...DEFAULT_DESIGN, ...(g.design ?? {}) };
}

export function photoJson(secrets: Secrets, p: Photo) {
  const ready = p.state === "ready";
  return {
    id: p.id,
    setId: p.setId,
    filename: p.filename,
    width: p.width,
    height: p.height,
    takenAt: p.takenAt?.getTime() ?? null,
    exif: p.exif ?? null,
    placeholder: p.placeholder,
    thumb: ready ? mediaUrl(secrets, p, "thumb") : null,
    preview: ready ? mediaUrl(secrets, p, "preview") : null,
  };
}

export function loadSetsAndPhotos(db: Db, galleryId: string): { sets: GallerySet[]; photos: Photo[] } {
  const sets = db.select().from(gallerySet).where(eq(gallerySet.galleryId, galleryId)).orderBy(asc(gallerySet.sort), asc(gallerySet.name)).all();
  const photos = db.select().from(photo).where(eq(photo.galleryId, galleryId)).orderBy(asc(photo.sort), asc(photo.filename)).all();
  const setOrder = new Map(sets.map((s, i) => [s.id, i]));
  photos.sort((a, b) => (setOrder.get(a.setId) ?? 0) - (setOrder.get(b.setId) ?? 0) || a.sort - b.sort || a.filename.localeCompare(b.filename, undefined, { numeric: true }));
  return { sets, photos };
}

/**
 * Whether a client may download originals from a set right now (docs/GALLERIES.md section 6.4).
 * Returns a reason when they may not, which the client page shows as-is.
 */
export function downloadState(g: Gallery, set: Pick<GallerySet, "earlyDownload"> | null): { allowed: true } | { allowed: false; reason: "off" | "locked" } {
  if (g.downloadSize === "none") return { allowed: false, reason: "off" };
  if (g.downloadLock === "none" || g.unlockedAt) return { allowed: true };
  if (g.downloadLock === "highlights_early" && set?.earlyDownload) return { allowed: true };
  return { allowed: false, reason: "locked" };
}
