import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { contact } from "./people.js";

const now = sql`(unixepoch('subsec') * 1000)`;

/**
 * Things on the calendar that are not shoot times: client appointments (a call, a consult, a pickup)
 * and personal blocks (vacation, school run). Shoot times live in `shoot_event`.
 */
export const calendarEntry = sqliteTable(
  "calendar_entry",
  {
    id: text().primaryKey(),
    kind: text({ enum: ["appointment", "block"] }).notNull(),
    title: text().notNull(),
    startsAt: integer({ mode: "timestamp_ms" }).notNull(),
    endsAt: integer({ mode: "timestamp_ms" }).notNull(),
    allDay: integer({ mode: "boolean" }).notNull().default(false),
    location: text(),
    notes: text(),
    contactId: text().references(() => contact.id, { onDelete: "set null" }),
    createdAt: integer({ mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("calendar_entry_start_idx").on(t.startsAt)],
);

/** The connected Google account and which of its calendars OpenPortrait uses. One row per calendar. */
export const googleCalendar = sqliteTable("google_calendar", {
  /** Google's calendar id. */
  id: text().primaryKey(),
  name: text().notNull(),
  /** "studio" is the calendar OpenPortrait writes to; "busy" calendars are read for busy times only. */
  role: text({ enum: ["studio", "busy"] }).notNull(),
  /** Incremental sync token from Google; null forces a full read. */
  syncToken: text(),
  syncedAt: integer({ mode: "timestamp_ms" }),
  lastError: text(),
});

/** Maps a local item to its Google event so edits and deletes reach the right one. */
export const googleLink = sqliteTable(
  "google_link",
  {
    id: text().primaryKey(),
    /** "shoot_event" or "calendar_entry". */
    itemType: text({ enum: ["shoot_event", "calendar_entry"] }).notNull(),
    itemId: text().notNull(),
    calendarId: text().notNull(),
    googleEventId: text().notNull(),
    etag: text(),
    /** Hash of what we last sent, so an unchanged item is not pushed again. */
    pushedHash: text(),
  },
  (t) => [uniqueIndex("google_link_item_idx").on(t.itemType, t.itemId), uniqueIndex("google_link_event_idx").on(t.calendarId, t.googleEventId)],
);

/** Busy times read from the other Google calendars. Titles are never stored. */
export const busyBlock = sqliteTable(
  "busy_block",
  {
    calendarId: text().notNull(),
    googleEventId: text().notNull(),
    startsAt: integer({ mode: "timestamp_ms" }).notNull(),
    endsAt: integer({ mode: "timestamp_ms" }).notNull(),
    allDay: integer({ mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("busy_block_pk").on(t.calendarId, t.googleEventId), index("busy_block_start_idx").on(t.startsAt)],
);
