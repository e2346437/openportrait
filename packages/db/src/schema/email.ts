import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch('subsec') * 1000)`;

/** Every email OpenPortrait tries to send, kept so the studio can see what went out and what failed. */
export const message = sqliteTable(
  "message",
  {
    id: text().primaryKey(),
    /** What it was for: "gallery.ready", "gallery.favorites", "test", ... */
    kind: text().notNull(),
    toEmail: text().notNull(),
    toName: text(),
    subject: text().notNull(),
    body: text().notNull(),
    status: text({ enum: ["sent", "failed"] }).notNull(),
    error: text(),
    contactId: text(),
    shootId: text(),
    galleryId: text(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("message_gallery_idx").on(t.galleryId, t.createdAt), index("message_contact_idx").on(t.contactId, t.createdAt)],
);
