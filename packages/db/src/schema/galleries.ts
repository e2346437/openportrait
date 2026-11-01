import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch('subsec') * 1000)`;

/** Presentation choices from the gallery Design tab (docs/GALLERIES.md section 6.2a). */
export interface GalleryDesign {
  layout: "full" | "split" | "framed" | "minimal";
  landing: "cards" | "photos";
  grid: "justified" | "masonry" | "square";
  size: "s" | "m" | "l";
  spacing: 0 | 4 | 8 | 18;
  theme: "light" | "dark";
  font: "serif" | "sans";
}

export const DEFAULT_DESIGN: GalleryDesign = { layout: "full", landing: "cards", grid: "justified", size: "m", spacing: 8, theme: "light", font: "serif" };

/**
 * A client gallery. Its photos live under `folderPath` (relative to GALLERIES_DIR):
 * the shoot folder's delivery folder (default `Gallery/`), or the folder itself for hand-made folders.
 */
export const gallery = sqliteTable(
  "gallery",
  {
    id: text().primaryKey(),
    /** Milestone 3 adds the shoot table; until then this stays null. */
    shootId: text(),
    slug: text().notNull(),
    title: text().notNull(),
    /** Shoot folder, relative to GALLERIES_DIR (the match target). */
    shootFolder: text().notNull(),
    /** Gallery root, relative to GALLERIES_DIR. Its subfolders are sets. */
    folderPath: text().notNull(),
    status: text({ enum: ["draft", "live", "archived"] }).notNull().default("draft"),
    sourceMissing: integer({ mode: "boolean" }).notNull().default(false),
    coverPhotoId: text(),
    coverFocalX: real().notNull().default(50),
    coverFocalY: real().notNull().default(50),
    /** Null means DEFAULT_DESIGN (or the studio default from Settings). */
    design: text({ mode: "json" }).$type<Partial<GalleryDesign>>(),
    accessMode: text({ enum: ["link", "password", "invited"] }).notNull().default("link"),
    passwordHash: text(),
    downloadSize: text({ enum: ["none", "web", "full"] }).notNull().default("full"),
    downloadLock: text({ enum: ["until_paid", "highlights_early", "none"] }).notNull().default("none"),
    unlockedAt: integer({ mode: "timestamp_ms" }),
    expiresAt: integer({ mode: "timestamp_ms" }),
    publishedAt: integer({ mode: "timestamp_ms" }),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [uniqueIndex("gallery_slug_idx").on(t.slug), uniqueIndex("gallery_folder_idx").on(t.shootFolder)],
);

export const gallerySet = sqliteTable(
  "gallery_set",
  {
    id: text().primaryKey(),
    galleryId: text()
      .notNull()
      .references(() => gallery.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** Subfolder name under the gallery root; "" for photos loose in the root. */
    folderName: text().notNull(),
    sort: integer().notNull().default(0),
    hidden: integer({ mode: "boolean" }).notNull().default(false),
    earlyDownload: integer({ mode: "boolean" }).notNull().default(false),
    coverPhotoId: text(),
    coverFocalX: real().notNull().default(50),
    coverFocalY: real().notNull().default(50),
  },
  (t) => [uniqueIndex("gallery_set_folder_idx").on(t.galleryId, t.folderName)],
);

export const photo = sqliteTable(
  "photo",
  {
    id: text().primaryKey(),
    galleryId: text()
      .notNull()
      .references(() => gallery.id, { onDelete: "cascade" }),
    setId: text()
      .notNull()
      .references(() => gallerySet.id, { onDelete: "cascade" }),
    /** Relative to GALLERIES_DIR. */
    relPath: text().notNull(),
    filename: text().notNull(),
    contentHash: text().notNull(),
    sizeBytes: integer().notNull(),
    mtimeMs: integer().notNull(),
    width: integer(),
    height: integer(),
    takenAt: integer({ mode: "timestamp_ms" }),
    exif: text({ mode: "json" }).$type<Record<string, unknown>>(),
    /** Tiny blurred base64 WebP shown while the thumbnail loads. */
    placeholder: text(),
    state: text({ enum: ["pending", "ready", "missing", "unsupported", "error"] }).notNull().default("pending"),
    error: text(),
    missingSince: integer({ mode: "timestamp_ms" }),
    /** Bumped whenever derivatives must be rebuilt; part of media URLs so caches never go stale. */
    version: integer().notNull().default(1),
    sort: integer().notNull().default(0),
    hidden: integer({ mode: "boolean" }).notNull().default(false),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [
    uniqueIndex("photo_path_idx").on(t.relPath),
    index("photo_gallery_idx").on(t.galleryId, t.setId, t.sort),
    index("photo_hash_idx").on(t.galleryId, t.contentHash),
  ],
);

/** A folder seen on the share that is not (yet) a gallery: the Unmatched folders inbox. */
export const ingestFolder = sqliteTable(
  "ingest_folder",
  {
    id: text().primaryKey(),
    relPath: text().notNull(),
    state: text({ enum: ["unmatched", "matched", "ignored"] }).notNull().default("unmatched"),
    fileCount: integer().notNull().default(0),
    takenFrom: integer({ mode: "timestamp_ms" }),
    takenTo: integer({ mode: "timestamp_ms" }),
    sampleFiles: text({ mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    stable: integer({ mode: "boolean" }).notNull().default(false),
    firstSeenAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    lastChangeAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    galleryId: text(),
  },
  (t) => [uniqueIndex("ingest_folder_path_idx").on(t.relPath)],
);

/** Photographer-defined favorites lists on a gallery (e.g. "Favorites", "Album picks" capped at 40). */
export const favoriteList = sqliteTable("favorite_list", {
  id: text().primaryKey(),
  galleryId: text()
    .notNull()
    .references(() => gallery.id, { onDelete: "cascade" }),
  name: text().notNull(),
  maxCount: integer(),
  sort: integer().notNull().default(0),
});

/** One client's picks for one list. */
export const favoriteSelection = sqliteTable(
  "favorite_selection",
  {
    id: text().primaryKey(),
    listId: text()
      .notNull()
      .references(() => favoriteList.id, { onDelete: "cascade" }),
    clientEmail: text().notNull(),
    submittedAt: integer({ mode: "timestamp_ms" }),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [uniqueIndex("favorite_selection_idx").on(t.listId, t.clientEmail)],
);

export const favoriteItem = sqliteTable(
  "favorite_item",
  {
    selectionId: text()
      .notNull()
      .references(() => favoriteSelection.id, { onDelete: "cascade" }),
    photoId: text()
      .notNull()
      .references(() => photo.id, { onDelete: "cascade" }),
    note: text().notNull().default(""),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.selectionId, t.photoId] })],
);

export const galleryView = sqliteTable(
  "gallery_view",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    galleryId: text()
      .notNull()
      .references(() => gallery.id, { onDelete: "cascade" }),
    clientEmail: text(),
    ipHash: text(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("gallery_view_idx").on(t.galleryId, t.createdAt)],
);

export const downloadEvent = sqliteTable(
  "download_event",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    galleryId: text()
      .notNull()
      .references(() => gallery.id, { onDelete: "cascade" }),
    photoId: text(),
    scope: text({ enum: ["photo", "set", "gallery", "favorites"] }).notNull(),
    variant: text({ enum: ["web", "full"] }).notNull(),
    clientEmail: text(),
    ip: text(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("download_event_idx").on(t.galleryId, t.createdAt)],
);
