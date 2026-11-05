import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { shoot } from "./pipeline.js";

const now = sql`(unixepoch('subsec') * 1000)`;

/** Presentation choices from the gallery Design tab (docs/GALLERIES.md section 6.2a). */
export interface GalleryDesign {
  layout: "full" | "split" | "framed" | "minimal";
  /** First page: set cards, every photo, or one chosen set (startSetId). */
  landing: "cards" | "photos" | "set";
  startSetId: string | null;
  /** How the top menu labels its links. */
  nav: "icons" | "text" | "both";
  /** Show each photo's file name under it. */
  filenames: boolean;
  grid: "justified" | "masonry" | "square";
  size: "s" | "m" | "l";
  spacing: 0 | 4 | 8 | 18;
  theme: "light" | "dark";
  font: "serif" | "sans";
}

export const DEFAULT_DESIGN: GalleryDesign = { layout: "full", landing: "cards", startSetId: null, nav: "both", filenames: false, grid: "justified", size: "m", spacing: 8, theme: "light", font: "serif" };

/**
 * A client gallery. Its photos live under `folderPath` (relative to GALLERIES_DIR):
 * the shoot folder's delivery folder (default `Gallery/`), or the folder itself for hand-made folders.
 */
export const gallery = sqliteTable(
  "gallery",
  {
    id: text().primaryKey(),
    /** Milestone 3 adds the shoot table; until then this stays null. */
    shootId: text().references(() => shoot.id, { onDelete: "set null" }),
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
    /** Who must give contact details before seeing photos. */
    registration: text({ enum: ["none", "email", "email_name"] }).notNull().default("none"),
    /** Shown on the cover and, while a gallery has no photos yet, as its placeholder. */
    welcomeMessage: text(),
    downloadSize: text({ enum: ["none", "web", "full"] }).notNull().default("full"),
    downloadLock: text({ enum: ["until_paid", "highlights_early", "none"] }).notNull().default("none"),
    /** Per-client caps (null = no cap): how many separate downloads, and how many files in total. */
    downloadMaxTimes: integer(),
    downloadMaxFiles: integer(),
    /**
     * Where this gallery's files go when an extension attaches remote storage. "default" follows the studio-wide
     * choice; "local" keeps them on this server; "offsite" moves them even if the studio default is off.
     * `storageOriginals` covers the shoot's Originals/RAW folder, `storageGallery` the delivered images.
     */
    storageOriginals: text({ enum: ["default", "local", "offsite"] }).notNull().default("default"),
    storageGallery: text({ enum: ["default", "local", "offsite"] }).notNull().default("default"),
    /**
     * Check Out: the shoot's offsite files were brought back for editing. `checkoutPrev` remembers the storage
     * choices so Check In can restore them; the totals measure progress; the gallery returns offsite on its own
     * after `checkoutReturnDays` without changes.
     */
    checkedOutAt: integer({ mode: "timestamp_ms" }),
    checkoutFolders: text({ enum: ["originals", "gallery", "both"] }),
    checkoutReturnDays: integer().notNull().default(14),
    checkoutPrev: text(),
    checkoutTotalFiles: integer().notNull().default(0),
    checkoutTotalBytes: integer().notNull().default(0),
    checkoutReadyAt: integer({ mode: "timestamp_ms" }),
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
    /** Set when an extension has moved the original out of the gallery folder. Previews stay local. */
    remoteKey: text(),
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

/**
 * A file in a shoot's Originals/RAW folder, tracked so an extension can move it to remote storage and bring it
 * back. These files never become gallery photos and are never served to clients. `shootFolder` matches
 * `gallery.shootFolder`, which is how a gallery's storage choice reaches them.
 */
export const rawFile = sqliteTable(
  "raw_file",
  {
    id: text().primaryKey(),
    shootFolder: text().notNull(),
    /** Relative to GALLERIES_DIR. */
    relPath: text().notNull(),
    filename: text().notNull(),
    sizeBytes: integer().notNull(),
    mtimeMs: integer().notNull(),
    /** Set when an extension has moved the file out of the Originals folder. */
    remoteKey: text(),
    missingSince: integer({ mode: "timestamp_ms" }),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [uniqueIndex("raw_file_path_idx").on(t.relPath), index("raw_file_folder_idx").on(t.shootFolder)],
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
    /** Files in this download: 1 for a photo, the part's photo count for a zip. */
    fileCount: integer().notNull().default(1),
    clientEmail: text(),
    ip: text(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("download_event_idx").on(t.galleryId, t.createdAt)],
);

/** Who has registered to view a gallery (when the gallery asks for contact details first). */
export const galleryVisitor = sqliteTable(
  "gallery_visitor",
  {
    galleryId: text()
      .notNull()
      .references(() => gallery.id, { onDelete: "cascade" }),
    email: text().notNull(),
    name: text(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.galleryId, t.email] })],
);
